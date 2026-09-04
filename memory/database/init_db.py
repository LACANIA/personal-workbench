"""Initialize the local Research Memory SQLite database."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MEMORY_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = MEMORY_ROOT / "schemas" / "memory_schema.sql"
MIGRATION_MANIFEST_PATH = MEMORY_ROOT / "migrations" / "migration_manifest.json"
DEFAULT_DATABASE_PATH = MEMORY_ROOT / "database" / "research_memory.db"


class DatabasePathError(ValueError):
    """Raised when a database path escapes the Research Memory directory."""


def resolve_database_path(database_path: str | Path | None = None) -> Path:
    """Return a canonical database path located inside MEMORY_ROOT."""
    candidate = Path(database_path) if database_path is not None else DEFAULT_DATABASE_PATH
    canonical_root = MEMORY_ROOT.resolve(strict=True)
    canonical_path = candidate.expanduser().resolve(strict=False)

    try:
        canonical_path.relative_to(canonical_root)
    except ValueError as exc:
        raise DatabasePathError(
            f"Database path must stay inside {canonical_root}: {canonical_path}"
        ) from exc

    return canonical_path


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _migration_metadata() -> tuple[int, list[dict[str, Any]]]:
    manifest = json.loads(MIGRATION_MANIFEST_PATH.read_text(encoding="utf-8"))
    entries = manifest.get("migrations", [])
    latest = manifest.get("latest_schema_version")
    if not isinstance(entries, list) or not entries or not isinstance(latest, int):
        raise RuntimeError("Migration manifest is incomplete")
    normalized: list[dict[str, Any]] = []
    expected_version = 2
    for entry in entries:
        if entry.get("version") != expected_version:
            raise RuntimeError("Migration manifest versions must be contiguous from version 2")
        sql_path = (MIGRATION_MANIFEST_PATH.parent / entry["file"]).resolve(strict=True)
        checksum = hashlib.sha256(sql_path.read_bytes()).hexdigest()
        if checksum != entry.get("sha256"):
            raise RuntimeError(
                f"Version {expected_version} migration checksum does not match its manifest"
            )
        normalized.append(
            {"version": expected_version, "name": entry["name"], "checksum": checksum}
        )
        expected_version += 1
    if latest != normalized[-1]["version"]:
        raise RuntimeError("latest_schema_version does not match migration entries")
    return latest, normalized


def initialize_database(database_path: str | Path | None = None) -> dict[str, Any]:
    """Create a fresh current-schema database, or validate an existing current database."""
    target_path = resolve_database_path(database_path)
    if not SCHEMA_PATH.is_file():
        raise FileNotFoundError(f"Schema file not found: {SCHEMA_PATH}")

    target_path.parent.mkdir(parents=True, exist_ok=True)
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")

    latest_version, migrations = _migration_metadata()

    try:
        with closing(sqlite3.connect(target_path)) as connection:
            connection.row_factory = sqlite3.Row
            existing_tables = [
                row[0]
                for row in connection.execute(
                    """
                    SELECT name FROM sqlite_master
                    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                    """
                ).fetchall()
            ]
            existing_version = connection.execute("PRAGMA user_version").fetchone()[0]
            if existing_tables and existing_version != latest_version:
                raise RuntimeError(
                    f"Existing database schema version is {existing_version}; use migrate_db.py"
                )
            with connection:
                connection.execute("PRAGMA foreign_keys = ON")
                connection.executescript(schema_sql)
                for migration in migrations:
                    connection.execute(
                        """
                        INSERT OR IGNORE INTO schema_migrations(version, name, checksum, applied_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (
                            migration["version"],
                            migration["name"],
                            migration["checksum"],
                            _utc_now(),
                        ),
                    )
                    recorded = connection.execute(
                        "SELECT name, checksum FROM schema_migrations WHERE version = ?",
                        (migration["version"],),
                    ).fetchone()
                    if recorded is None or dict(recorded) != {
                        "name": migration["name"],
                        "checksum": migration["checksum"],
                    }:
                        raise RuntimeError(
                            f"Existing version {migration['version']} migration record differs from the manifest"
                        )
                tables = [
                    row[0]
                    for row in connection.execute(
                        """
                        SELECT name
                        FROM sqlite_master
                        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                        ORDER BY name
                        """
                    ).fetchall()
                ]
                integrity_check = connection.execute("PRAGMA integrity_check").fetchone()[0]
                encoding = connection.execute("PRAGMA encoding").fetchone()[0]
                user_version = connection.execute("PRAGMA user_version").fetchone()[0]
    except sqlite3.Error as exc:
        raise RuntimeError(f"SQLite initialization failed for {target_path}: {exc}") from exc

    return {
        "database_path": str(target_path),
        "schema_path": str(SCHEMA_PATH),
        "tables": tables,
        "table_count": len(tables),
        "integrity_check": integrity_check,
        "encoding": encoding,
        "schema_version": user_version,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize the Research Memory database.")
    parser.add_argument(
        "--database",
        type=Path,
        default=DEFAULT_DATABASE_PATH,
        help="SQLite file path inside the memory directory.",
    )
    args = parser.parse_args()
    result = initialize_database(args.database)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
