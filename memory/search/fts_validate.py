"""Offline validation for the Document Chunk FTS5 index."""

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
from memory.database.init_db import resolve_database_path  # noqa: E402
from memory.search.fts_state import (  # noqa: E402
    strict_fts_integrity_check,
    validate_fts_index,
)


def validate_database_fts(database: str | Path) -> dict[str, Any]:
    """Run SQLite, foreign-key, signature, count, and FTS5 integrity checks."""
    started = perf_counter()
    database_path = resolve_database_path(database)
    if not database_path.is_file():
        raise FileNotFoundError(f"database not found: {database_path}")
    connection = sqlite3.connect(database_path, timeout=15.0, isolation_level=None)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("BEGIN")
        try:
            strict_fts_integrity_check(connection)
            result = validate_fts_index(connection)
        finally:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
    except sqlite3.Error as exc:
        raise MemoryStorageError(f"FTS validation failed: {exc}") from exc
    finally:
        connection.close()
    return {
        "database_path": str(database_path),
        "fts_integrity_check": "ok",
        **result,
        "duration_ms": round((perf_counter() - started) * 1000, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the Document Chunk FTS5 index.")
    parser.add_argument("--database", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(validate_database_fts(args.database), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
