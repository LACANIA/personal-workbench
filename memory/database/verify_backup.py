"""Verify a Research Memory backup through a temporary SQLite restore."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4


MY_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(MY_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(MY_AGENT_ROOT))

from memory.database.backup_db import BACKUP_ROOT  # noqa: E402
from memory.database.validate_db import inspect_database, sha256_file  # noqa: E402


def _inside_backup_root(path: str | Path) -> Path:
    root = BACKUP_ROOT.resolve(strict=False)
    candidate = Path(path).resolve(strict=False)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"path must stay inside {root}: {candidate}") from exc
    return candidate


def _load_manifest(manifest_path: str | Path) -> tuple[Path, dict[str, Any]]:
    path = _inside_backup_root(manifest_path)
    if not path.is_file():
        raise FileNotFoundError(f"backup manifest not found: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("manifest_version") != 1:
        raise ValueError("unsupported backup manifest version")
    return path, payload


def verify_backup(
    manifest_path: str | Path, *, expect_project: str | None = None
) -> dict[str, Any]:
    """Restore one backup to a temporary path, validate it, and remove the restore."""
    manifest_file, manifest = _load_manifest(manifest_path)
    backup_path = _inside_backup_root(manifest["backup_database"])
    if not backup_path.is_file():
        raise FileNotFoundError(f"backup database not found: {backup_path}")
    if sha256_file(backup_path) != manifest["backup_sha256"]:
        raise RuntimeError("backup SHA-256 differs from the manifest")

    backup_inspection = inspect_database(backup_path)
    if backup_inspection["user_version"] != manifest["schema_version"]:
        raise RuntimeError("backup schema version differs from the manifest")
    if backup_inspection["table_counts"] != manifest["table_counts"]:
        raise RuntimeError("backup table counts differ from the manifest")
    if not backup_inspection["valid"]:
        raise RuntimeError("backup integrity validation failed")

    restore_directory = BACKUP_ROOT / ".restore-validation"
    restore_directory.mkdir(parents=True, exist_ok=True)
    restore_path = restore_directory / f"restore-{uuid4().hex}.db"
    source_connection: sqlite3.Connection | None = None
    target_connection: sqlite3.Connection | None = None
    restore_inspection: dict[str, Any] | None = None
    project_found: bool | None = None
    try:
        source_connection = sqlite3.connect(
            f"{backup_path.as_uri()}?mode=ro", uri=True, timeout=5.0
        )
        source_connection.execute("PRAGMA query_only = ON")
        target_connection = sqlite3.connect(restore_path)
        source_connection.backup(target_connection)
        target_connection.commit()
        target_connection.close()
        target_connection = None
        source_connection.close()
        source_connection = None

        restore_inspection = inspect_database(restore_path)
        if restore_inspection["user_version"] != manifest["schema_version"]:
            raise RuntimeError("restored schema version differs from the manifest")
        if restore_inspection["table_counts"] != manifest["table_counts"]:
            raise RuntimeError("restored table counts differ from the manifest")
        if not restore_inspection["valid"]:
            raise RuntimeError("restored database integrity validation failed")

        if expect_project is not None:
            connection = sqlite3.connect(
                f"{restore_path.as_uri()}?mode=ro", uri=True, timeout=5.0
            )
            try:
                connection.execute("PRAGMA query_only = ON")
                project_found = (
                    connection.execute(
                        "SELECT 1 FROM projects WHERE name = ?", (expect_project,)
                    ).fetchone()
                    is not None
                )
            finally:
                connection.close()
            if not project_found:
                raise RuntimeError(f"expected project not found in restored backup: {expect_project}")
    finally:
        if target_connection is not None:
            target_connection.close()
        if source_connection is not None:
            source_connection.close()
        for candidate in (
            restore_path,
            Path(f"{restore_path}-wal"),
            Path(f"{restore_path}-shm"),
        ):
            candidate.unlink(missing_ok=True)

    return {
        "manifest_path": str(manifest_file),
        "backup_database": str(backup_path),
        "schema_version": restore_inspection["user_version"],
        "table_counts": restore_inspection["table_counts"],
        "integrity_check": restore_inspection["integrity_check"],
        "foreign_key_check": restore_inspection["foreign_key_check"],
        "expected_project": expect_project,
        "project_found": project_found,
        "temporary_restore_removed": not restore_path.exists(),
        "valid": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify a Research Memory backup.")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--expect-project")
    args = parser.parse_args()
    result = verify_backup(args.manifest, expect_project=args.expect_project)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
