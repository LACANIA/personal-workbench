"""Create manifest-backed SQLite backups for Research Memory."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4


MY_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(MY_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(MY_AGENT_ROOT))

from memory.database.init_db import MEMORY_ROOT, resolve_database_path  # noqa: E402
from memory.database.validate_db import inspect_database, sha256_file  # noqa: E402


BACKUP_ROOT = MEMORY_ROOT / "backups"
_LABEL_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,50}$")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _backup_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def _resolve_backup_directory(value: str | Path | None) -> Path:
    root = BACKUP_ROOT.resolve(strict=False)
    candidate = Path(value).resolve(strict=False) if value is not None else root
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"backup directory must stay inside {root}: {candidate}") from exc
    return candidate


def backup_database(
    source_database: str | Path,
    *,
    backup_directory: str | Path | None = None,
    label: str = "memory",
) -> dict[str, Any]:
    """Create one SQLite backup and a JSON manifest without overwriting prior files."""
    if not _LABEL_PATTERN.fullmatch(label):
        raise ValueError("label must use lowercase letters, digits, underscores, or hyphens")
    source_path = resolve_database_path(source_database)
    if not source_path.is_file():
        raise FileNotFoundError(f"source database not found: {source_path}")
    target_directory = _resolve_backup_directory(backup_directory)
    target_directory.mkdir(parents=True, exist_ok=True)

    token = f"{_backup_timestamp()}-{uuid4().hex[:8]}"
    backup_path = target_directory / f"{label}-{token}.db"
    manifest_path = target_directory / f"{label}-{token}.manifest.json"
    if backup_path.exists() or manifest_path.exists():
        raise FileExistsError("generated backup target already exists")

    source_before = inspect_database(source_path)
    source_connection = sqlite3.connect(
        f"{source_path.as_uri()}?mode=ro", uri=True, timeout=5.0
    )
    target_connection = sqlite3.connect(backup_path)
    try:
        source_connection.execute("PRAGMA query_only = ON")
        source_connection.backup(target_connection)
        target_connection.commit()
    except Exception:
        target_connection.close()
        source_connection.close()
        backup_path.unlink(missing_ok=True)
        raise
    else:
        target_connection.close()
        source_connection.close()

    source_after = inspect_database(source_path)
    if source_after["sha256"] != source_before["sha256"]:
        backup_path.unlink(missing_ok=True)
        raise RuntimeError("source database changed while the backup was running")

    backup_inspection = inspect_database(backup_path)
    if not backup_inspection["valid"]:
        backup_path.unlink(missing_ok=True)
        raise RuntimeError("backup database failed integrity validation")
    if backup_inspection["user_version"] != source_before["user_version"]:
        backup_path.unlink(missing_ok=True)
        raise RuntimeError("backup schema version differs from the source database")
    if backup_inspection["table_counts"] != source_before["table_counts"]:
        backup_path.unlink(missing_ok=True)
        raise RuntimeError("backup table counts differ from the source database")

    manifest = {
        "manifest_version": 1,
        "source_database": str(source_path),
        "backup_database": str(backup_path),
        "created_at": _utc_now(),
        "schema_version": source_before["user_version"],
        "database_sha256": source_before["sha256"],
        "backup_sha256": sha256_file(backup_path),
        "table_counts": source_before["table_counts"],
        "integrity_check": backup_inspection["integrity_check"],
        "foreign_key_check": backup_inspection["foreign_key_check"],
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {**manifest, "manifest_path": str(manifest_path)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Back up a Research Memory database.")
    parser.add_argument("database", type=Path)
    parser.add_argument("--backup-directory", type=Path)
    parser.add_argument("--label", default="memory")
    args = parser.parse_args()
    result = backup_database(
        args.database,
        backup_directory=args.backup_directory,
        label=args.label,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
