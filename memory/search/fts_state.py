"""Deterministic FTS5 signatures, state records, and consistency checks."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Iterable

from memory.api.memory_api import MemoryStorageError


SCHEMA_VERSION = 4
INDEX_NAME = "document_chunks_fts"
TOKENIZER = "trigram"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _digest_rows(rows: Iterable[tuple[Any, ...]]) -> str:
    digest = hashlib.sha256()
    for row in rows:
        encoded = json.dumps(
            [value.hex() if isinstance(value, bytes) else value for value in row],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def require_schema_v4(connection: sqlite3.Connection) -> None:
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version != SCHEMA_VERSION:
        raise MemoryStorageError(
            f"Document Chunk search requires schema version {SCHEMA_VERSION}; found {version}"
        )
    required = {
        INDEX_NAME,
        "document_chunks_fts_vocab",
        "document_chunk_fts_state",
    }
    present = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_schema WHERE name IN (?, ?, ?)", tuple(sorted(required))
        )
    }
    missing = sorted(required.difference(present))
    if missing:
        raise MemoryStorageError(f"Document Chunk FTS schema is incomplete: {missing}")


def source_signature(connection: sqlite3.Connection) -> tuple[int, str]:
    rows = connection.execute(
        """
        SELECT dc.id, dc.chunk_uid, dc.content_hash, dv.id, da.id
        FROM document_chunks AS dc
        JOIN document_versions AS dv ON dv.id = dc.document_version_id
        JOIN document_assets AS da ON da.id = dv.asset_id
        ORDER BY dc.id
        """
    ).fetchall()
    return len(rows), _digest_rows(tuple(tuple(row) for row in rows))


def index_signature(connection: sqlite3.Connection) -> tuple[int, str]:
    indexed_row_count = connection.execute(
        "SELECT COUNT(*) FROM document_chunks_fts_docsize"
    ).fetchone()[0]
    vocab_rows = connection.execute(
        """
        SELECT term, doc, col, offset
        FROM document_chunks_fts_vocab
        ORDER BY term, doc, col, offset
        """
    ).fetchall()
    docsize_rows = connection.execute(
        "SELECT id, sz FROM document_chunks_fts_docsize ORDER BY id"
    ).fetchall()
    signature = _digest_rows(
        [("vocab", *tuple(row)) for row in vocab_rows]
        + [("docsize", *tuple(row)) for row in docsize_rows]
    )
    return indexed_row_count, signature


def state_row(connection: sqlite3.Connection) -> dict[str, Any] | None:
    row = connection.execute(
        "SELECT * FROM document_chunk_fts_state WHERE id = 1"
    ).fetchone()
    return None if row is None else dict(row)


def require_query_ready(connection: sqlite3.Connection) -> dict[str, Any]:
    """Perform bounded readiness checks suitable for every read-only query."""
    require_schema_v4(connection)
    stored = state_row(connection)
    if stored is None or stored["status"] != "valid":
        raise MemoryStorageError("Document Chunk FTS index has no valid maintenance state")
    source_count = connection.execute("SELECT COUNT(*) FROM document_chunks").fetchone()[0]
    indexed_count = connection.execute(
        "SELECT COUNT(*) FROM document_chunks_fts_docsize"
    ).fetchone()[0]
    if (
        source_count != indexed_count
        or stored["source_chunk_count"] != source_count
        or stored["indexed_row_count"] != indexed_count
    ):
        raise MemoryStorageError("Document Chunk FTS index is stale; run the offline rebuild command")
    return stored


def strict_fts_integrity_check(connection: sqlite3.Connection) -> None:
    try:
        connection.execute(
            "INSERT INTO document_chunks_fts(document_chunks_fts, rank) "
            "VALUES ('integrity-check', 1)"
        )
    except sqlite3.DatabaseError as exc:
        raise MemoryStorageError(f"FTS5 integrity-check failed: {exc}") from exc


def computed_state(connection: sqlite3.Connection) -> dict[str, Any]:
    require_schema_v4(connection)
    source_count, source_hash = source_signature(connection)
    indexed_count, index_hash = index_signature(connection)
    return {
        "index_name": INDEX_NAME,
        "tokenizer": TOKENIZER,
        "source_chunk_count": source_count,
        "indexed_row_count": indexed_count,
        "source_signature": source_hash,
        "index_signature": index_hash,
        "schema_version": SCHEMA_VERSION,
    }


def write_valid_state(connection: sqlite3.Connection, *, built_at: str | None = None) -> dict[str, Any]:
    value = computed_state(connection)
    if value["source_chunk_count"] != value["indexed_row_count"]:
        raise MemoryStorageError("FTS5 indexed row count differs from document_chunks")
    timestamp = utc_now()
    built = built_at or timestamp
    connection.execute(
        """
        INSERT INTO document_chunk_fts_state(
            id, index_name, tokenizer, built_at, validated_at,
            source_chunk_count, indexed_row_count, source_signature,
            index_signature, schema_version, status
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid')
        ON CONFLICT(id) DO UPDATE SET
            index_name = excluded.index_name,
            tokenizer = excluded.tokenizer,
            built_at = excluded.built_at,
            validated_at = excluded.validated_at,
            source_chunk_count = excluded.source_chunk_count,
            indexed_row_count = excluded.indexed_row_count,
            source_signature = excluded.source_signature,
            index_signature = excluded.index_signature,
            schema_version = excluded.schema_version,
            status = excluded.status
        """,
        (
            value["index_name"],
            value["tokenizer"],
            built,
            timestamp,
            value["source_chunk_count"],
            value["indexed_row_count"],
            value["source_signature"],
            value["index_signature"],
            value["schema_version"],
        ),
    )
    return {"id": 1, **value, "built_at": built, "validated_at": timestamp, "status": "valid"}


def validate_fts_index(
    connection: sqlite3.Connection, *, require_valid_state: bool = True
) -> dict[str, Any]:
    value = computed_state(connection)
    stored = state_row(connection)
    checks = {
        "source_and_index_counts_match": (
            value["source_chunk_count"] == value["indexed_row_count"]
        ),
        "state_exists": stored is not None,
        "state_status_valid": stored is not None and stored["status"] == "valid",
        "state_source_count_matches": (
            stored is not None and stored["source_chunk_count"] == value["source_chunk_count"]
        ),
        "state_index_count_matches": (
            stored is not None and stored["indexed_row_count"] == value["indexed_row_count"]
        ),
        "state_source_signature_matches": (
            stored is not None and stored["source_signature"] == value["source_signature"]
        ),
        "state_index_signature_matches": (
            stored is not None and stored["index_signature"] == value["index_signature"]
        ),
    }
    integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
    foreign_keys = [list(row) for row in connection.execute("PRAGMA foreign_key_check")]
    valid = all(checks.values()) and integrity == ["ok"] and not foreign_keys
    if require_valid_state and not valid:
        failed = [name for name, passed in checks.items() if not passed]
        raise MemoryStorageError(f"Document Chunk FTS state is invalid: {failed}")
    return {
        **value,
        "stored_state": stored,
        "checks": checks,
        "integrity_check": integrity,
        "foreign_key_check": foreign_keys,
        "valid": valid,
    }
