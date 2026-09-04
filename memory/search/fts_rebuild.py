"""Offline, backup-gated rebuild of the Document Chunk FTS5 index."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from time import perf_counter
from typing import Any


MY_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(MY_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(MY_AGENT_ROOT))

from memory.api.memory_api import MemoryStorageError  # noqa: E402
from memory.database.backup_db import backup_database  # noqa: E402
from memory.database.init_db import resolve_database_path  # noqa: E402
from memory.database.migrate_db import PROTECTED_TABLES  # noqa: E402
from memory.database.verify_backup import verify_backup  # noqa: E402
from memory.search.fts_state import (  # noqa: E402
    require_schema_v4,
    strict_fts_integrity_check,
    validate_fts_index,
    write_valid_state,
)


def _counts(connection: sqlite3.Connection) -> dict[str, int]:
    present = {
        row[0]
        for row in connection.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")
    }
    return {
        table: connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        for table in PROTECTED_TABLES
        if table in present
    }


def rebuild_fts_index(
    database: str | Path,
    *,
    create_backup: bool = True,
    backup_label: str | None = None,
) -> dict[str, Any]:
    """Rebuild the derived FTS index and record deterministic index state."""
    started = perf_counter()
    database_path = resolve_database_path(database)
    if not database_path.is_file():
        raise FileNotFoundError(f"database not found: {database_path}")

    backup: dict[str, Any] | None = None
    backup_verification: dict[str, Any] | None = None
    if create_backup:
        label = backup_label or f"step14-fts-{database_path.stem.lower().replace('_', '-')}"
        backup = backup_database(database_path, label=label)
        backup_verification = verify_backup(backup["manifest_path"])

    connection = sqlite3.connect(database_path, timeout=15.0, isolation_level=None)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 15000")
        require_schema_v4(connection)
        before_counts = _counts(connection)
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute(
                "INSERT INTO document_chunks_fts(document_chunks_fts) VALUES ('rebuild')"
            )
            strict_fts_integrity_check(connection)
            state = write_valid_state(connection)
            validation = validate_fts_index(connection)
            after_counts = _counts(connection)
            if after_counts != before_counts:
                raise MemoryStorageError("FTS rebuild changed protected Research Memory records")
            connection.execute("COMMIT")
        except Exception:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
    except sqlite3.Error as exc:
        raise MemoryStorageError(f"FTS rebuild failed: {exc}") from exc
    finally:
        connection.close()

    return {
        "database_path": str(database_path),
        "backup": backup,
        "backup_verification": backup_verification,
        "protected_counts": before_counts,
        "state": state,
        "validation": validation,
        "duration_ms": round((perf_counter() - started) * 1000, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Rebuild the Document Chunk FTS5 index.")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup-label")
    args = parser.parse_args()
    result = rebuild_fts_index(
        args.database,
        create_backup=True,
        backup_label=args.backup_label,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
