"""Public read-only Document Chunk search and exact-read APIs."""

from __future__ import annotations

import json
import re
from time import perf_counter
from typing import Any

from memory.api.memory_api import (
    DatabaseArgument,
    MemoryNotFoundError,
    MemoryValidationError,
    _connection,
)
from memory.search.chunk_search import search_document_chunks
from memory.search.fts_state import require_query_ready


_CHUNK_UID = re.compile(r"^[0-9a-fA-F]{64}$")
MAX_CHUNK_CONTENT_CHARS = 8000


def get_document_chunk(
    chunk_uid: str,
    *,
    database: DatabaseArgument = None,
    include_content: bool = True,
) -> dict[str, Any]:
    started = perf_counter()
    if not isinstance(chunk_uid, str) or not _CHUNK_UID.fullmatch(chunk_uid.strip()):
        raise MemoryValidationError("chunk_uid must contain exactly 64 hexadecimal characters")
    if not isinstance(include_content, bool):
        raise MemoryValidationError("include_content must be a boolean")
    normalized_uid = chunk_uid.strip().lower()
    with _connection(database, read_only=True) as connection:
        state = require_query_ready(connection)
        row = connection.execute(
            """
            WITH version_ranks AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY asset_id
                        ORDER BY created_at DESC, id DESC
                    ) AS version_rank
                FROM document_versions
            )
            SELECT
                dc.id AS chunk_id,
                dc.chunk_uid,
                dc.chunk_index,
                dc.heading_path_json,
                dc.start_line,
                dc.end_line,
                dc.content,
                dc.char_count,
                dc.content_hash,
                p.name AS project_name,
                md.id AS document_memory_id,
                da.id AS asset_id,
                dv.id AS document_version_id,
                dv.source_id,
                dv.source_version,
                da.canonical_path,
                da.document_type,
                da.title,
                CASE WHEN vr.version_rank = 1 THEN 1 ELSE 0 END AS is_latest_version
            FROM document_chunks AS dc
            JOIN document_versions AS dv ON dv.id = dc.document_version_id
            JOIN version_ranks AS vr ON vr.id = dv.id
            JOIN document_assets AS da ON da.id = dv.asset_id
            JOIN projects AS p ON p.id = da.project_id
            JOIN documents AS md ON md.id = dv.memory_document_id
            WHERE dc.chunk_uid = ? COLLATE NOCASE
            """,
            (normalized_uid,),
        ).fetchone()
    if row is None:
        raise MemoryNotFoundError(f"Document Chunk does not exist: {normalized_uid}")
    value = dict(row)
    content = value.pop("content")
    if include_content:
        returned_content = content[:MAX_CHUNK_CONTENT_CHARS]
        content_truncated = len(content) > MAX_CHUNK_CONTENT_CHARS
    else:
        returned_content = None
        content_truncated = False
    path = value["canonical_path"]
    return {
        "status": "OK",
        "chunk_id": value["chunk_id"],
        "chunk_uid": value["chunk_uid"],
        "chunk_index": value["chunk_index"],
        "project_name": value["project_name"],
        "document_memory_id": value["document_memory_id"],
        "asset_id": value["asset_id"],
        "document_version_id": value["document_version_id"],
        "source_id": value["source_id"],
        "source_version": value["source_version"],
        "canonical_path": path,
        "document_type": value["document_type"],
        "title": value["title"],
        "heading_path": json.loads(value["heading_path_json"]),
        "start_line": value["start_line"],
        "end_line": value["end_line"],
        "content": returned_content,
        "content_included": include_content,
        "content_truncated": content_truncated,
        "char_count": value["char_count"],
        "content_hash": value["content_hash"],
        "is_latest_version": bool(value["is_latest_version"]),
        "memory_citation": f"[Memory:document#{value['document_memory_id']}]",
        "source_citation": (
            f"[Source:{value['source_id']} {path}:{value['start_line']}-{value['end_line']}]"
        ),
        "chunk_citation": (
            f"[Chunk:{value['chunk_uid']} {path}:{value['start_line']}-{value['end_line']}]"
        ),
        "index_validated_at": state["validated_at"],
        "duration_ms": round((perf_counter() - started) * 1000, 3),
    }
