"""Read-only inspection and validation for Research Memory databases."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from typing import Any


MY_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(MY_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(MY_AGENT_ROOT))

from memory.database.init_db import resolve_database_path  # noqa: E402


def sha256_file(path: str | Path) -> str:
    """Return the lowercase SHA-256 digest for one file."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _read_only_connection(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=5.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA query_only = ON")
    return connection


def inspect_database(database_path: str | Path) -> dict[str, Any]:
    """Inspect one database without permitting SQLite writes."""
    path = resolve_database_path(database_path)
    if not path.is_file():
        raise FileNotFoundError(f"database not found: {path}")

    with closing(_read_only_connection(path)) as connection:
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
        table_counts = {
            table: connection.execute(
                f"SELECT COUNT(*) FROM {_quote_identifier(table)}"
            ).fetchone()[0]
            for table in tables
        }
        integrity_rows = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        foreign_key_rows = [list(row) for row in connection.execute("PRAGMA foreign_key_check")]
        migration_rows: list[dict[str, Any]] = []
        if "schema_migrations" in tables:
            migration_rows = [
                dict(row)
                for row in connection.execute(
                    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version"
                )
            ]
        query_only = connection.execute("PRAGMA query_only").fetchone()[0]
        user_version = connection.execute("PRAGMA user_version").fetchone()[0]
        encoding = connection.execute("PRAGMA encoding").fetchone()[0]

    return {
        "database_path": str(path),
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
        "user_version": user_version,
        "encoding": encoding,
        "query_only": query_only,
        "tables": tables,
        "table_counts": table_counts,
        "schema_migrations": migration_rows,
        "integrity_check": integrity_rows,
        "foreign_key_check": foreign_key_rows,
        "valid": integrity_rows == ["ok"] and foreign_key_rows == [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Research Memory database.")
    parser.add_argument("database", type=Path)
    parser.add_argument("--expect-version", type=int)
    args = parser.parse_args()

    result = inspect_database(args.database)
    if args.expect_version is not None and result["user_version"] != args.expect_version:
        raise RuntimeError(
            f"expected schema version {args.expect_version}, found {result['user_version']}"
        )
    if not result["valid"]:
        raise RuntimeError("database integrity or foreign-key validation failed")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
