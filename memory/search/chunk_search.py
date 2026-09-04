"""Bounded, filterable FTS5 and deterministic short-query Chunk search."""

from __future__ import annotations

import json
import ntpath
from time import perf_counter
from typing import Any, Iterable

from memory.api.memory_api import (
    DatabaseArgument,
    MemoryValidationError,
    _connection,
)
from memory.search.fts_state import require_query_ready
from memory.search.query_parser import ParsedSearchQuery, parse_search_query


VERSION_SCOPES = {"latest", "all", "specific"}
DEFAULT_LIMIT = 8
MAX_LIMIT = 20
DEFAULT_TOTAL_CHARS = 4000
MAX_TOTAL_CHARS = 12000
MAX_SNIPPET_CHARS = 600


def _optional_positive_id(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise MemoryValidationError(f"{field} must be a positive integer")
    return value


def _bounded_integer(value: Any, field: str, default: int, maximum: int) -> int:
    candidate = default if value is None else value
    if isinstance(candidate, bool) or not isinstance(candidate, int) or not 1 <= candidate <= maximum:
        raise MemoryValidationError(f"{field} must be an integer from 1 to {maximum}")
    return candidate


def _optional_text(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise MemoryValidationError(f"{field} must be a non-empty string when provided")
    return value.strip()


def _canonical_path_filter(value: Any) -> str | None:
    path = _optional_text(value, "document_path")
    if path is None:
        return None
    windows = path.replace("/", "\\")
    if windows.startswith("\\\\") or not ntpath.isabs(windows):
        raise MemoryValidationError("document_path must be a local absolute path")
    drive, tail = ntpath.splitdrive(windows)
    if not drive or ":" in tail:
        raise MemoryValidationError("document_path must not be UNC, a device path, or an alternate stream")
    return ntpath.normpath(windows)


def _version_filter(
    version_scope: str,
    document_version_id: int | None,
) -> tuple[str, list[Any]]:
    if version_scope not in VERSION_SCOPES:
        raise MemoryValidationError("version_scope must be latest, all, or specific")
    if version_scope == "specific":
        if document_version_id is None:
            raise MemoryValidationError(
                "document_version_id is required when version_scope is specific"
            )
        return "dv.id = ?", [document_version_id]
    if document_version_id is not None:
        raise MemoryValidationError(
            "document_version_id may only be provided when version_scope is specific"
        )
    if version_scope == "latest":
        return "vr.version_rank = 1", []
    return "1 = 1", []


def _base_query(
    *,
    project_name: str | None,
    document_path: str | None,
    asset_id: int | None,
    document_version_id: int | None,
    version_scope: str,
) -> tuple[str, list[Any]]:
    version_clause, version_parameters = _version_filter(version_scope, document_version_id)
    clauses = [version_clause]
    parameters: list[Any] = list(version_parameters)
    if project_name is not None:
        clauses.append("p.name = ?")
        parameters.append(project_name)
    if document_path is not None:
        clauses.append("da.canonical_path = ? COLLATE NOCASE")
        parameters.append(document_path)
    if asset_id is not None:
        clauses.append("da.id = ?")
        parameters.append(asset_id)
    return " AND ".join(clauses), parameters


BASE_CTE = """
WITH version_ranks AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY asset_id
            ORDER BY created_at DESC, id DESC
        ) AS version_rank
    FROM document_versions
)
"""


JOIN_SQL = """
FROM document_chunks AS dc
JOIN document_versions AS dv ON dv.id = dc.document_version_id
JOIN version_ranks AS vr ON vr.id = dv.id
JOIN document_assets AS da ON da.id = dv.asset_id
JOIN projects AS p ON p.id = da.project_id
JOIN documents AS md ON md.id = dv.memory_document_id
JOIN sources AS s ON s.id = dv.source_id
"""


SELECT_COLUMNS = """
SELECT
    dc.id AS chunk_id,
    dc.chunk_uid,
    dc.chunk_index,
    dc.heading_path_json,
    dc.start_line AS chunk_start_line,
    dc.end_line AS chunk_end_line,
    dc.content,
    dc.content_hash,
    dc.char_count,
    p.id AS project_id,
    p.name AS project_name,
    md.id AS document_memory_id,
    da.id AS asset_id,
    dv.id AS document_version_id,
    dv.source_id,
    dv.source_version,
    COALESCE(s.canonical_path, s.external_ref, da.canonical_path) AS source_reference,
    da.canonical_path,
    da.document_type,
    da.title,
    CASE WHEN vr.version_rank = 1 THEN 1 ELSE 0 END AS is_latest_version
"""


def _casefold_find(text: str, values: Iterable[str]) -> int:
    folded = text.casefold()
    positions = [folded.find(value.casefold()) for value in values]
    valid = [position for position in positions if position >= 0]
    return min(valid) if valid else -1


def _matches_scan(row: dict[str, Any], parsed: ParsedSearchQuery) -> tuple[bool, int]:
    if parsed.field_scope == "content":
        haystack = row["content"]
    elif parsed.field_scope == "heading":
        haystack = row["heading_path_json"]
    else:
        haystack = row["content"] + "\n" + row["heading_path_json"]
    folded = haystack.casefold()
    folded_terms = [term.casefold() for term in parsed.terms]
    if parsed.match_mode == "phrase":
        matched = folded_terms[0] in folded
    elif parsed.match_mode == "all":
        matched = all(term in folded for term in folded_terms)
    else:
        matched = any(term in folded for term in folded_terms)
    return matched, _casefold_find(haystack, parsed.terms) if matched else -1


def _snippet(
    content: str,
    *,
    chunk_start_line: int,
    parsed: ParsedSearchQuery,
    maximum: int = MAX_SNIPPET_CHARS,
) -> dict[str, Any]:
    lines = content.split("\n")
    matched_line = 0
    for index, line in enumerate(lines):
        if _casefold_find(line, parsed.terms) >= 0:
            matched_line = index
            break

    first = matched_line
    last = matched_line
    while True:
        candidates: list[tuple[int, int]] = []
        if first > 0:
            candidates.append((first - 1, last))
        if last + 1 < len(lines):
            candidates.append((first, last + 1))
        selected: tuple[int, int] | None = None
        for candidate in candidates:
            value = "\n".join(lines[candidate[0] : candidate[1] + 1])
            if len(value) <= maximum:
                selected = candidate
                break
        if selected is None:
            break
        first, last = selected

    value = "\n".join(lines[first : last + 1])
    snippet_truncated = first > 0 or last < len(lines) - 1
    if len(value) > maximum:
        position = _casefold_find(value, parsed.terms)
        start = max(0, position - maximum // 3) if position >= 0 else 0
        value = value[start : start + maximum]
        snippet_truncated = True
    return {
        "snippet": value,
        "snippet_start_line": chunk_start_line + first,
        "snippet_end_line": chunk_start_line + last,
        "snippet_truncated": snippet_truncated,
    }


def _result(row: dict[str, Any], parsed: ParsedSearchQuery) -> dict[str, Any]:
    snippet = _snippet(
        row["content"], chunk_start_line=row["chunk_start_line"], parsed=parsed
    )
    canonical_path = row["canonical_path"]
    memory_citation = f"[Memory:document#{row['document_memory_id']}]"
    source_citation = (
        f"[Source:{row['source_id']} {row['source_reference']}:"
        f"{snippet['snippet_start_line']}-{snippet['snippet_end_line']}]"
    )
    chunk_citation = (
        f"[Chunk:{row['chunk_uid']} {canonical_path}:"
        f"{snippet['snippet_start_line']}-{snippet['snippet_end_line']}]"
    )
    return {
        "rank": 0,
        "chunk_id": row["chunk_id"],
        "chunk_uid": row["chunk_uid"],
        "chunk_index": row["chunk_index"],
        "project_id": row["project_id"],
        "project_name": row["project_name"],
        "document_memory_id": row["document_memory_id"],
        "asset_id": row["asset_id"],
        "document_version_id": row["document_version_id"],
        "source_id": row["source_id"],
        "source_version": row["source_version"],
        "source_reference": row["source_reference"],
        "canonical_path": canonical_path,
        "document_type": row["document_type"],
        "title": row["title"],
        "heading_path": json.loads(row["heading_path_json"]),
        "chunk_start_line": row["chunk_start_line"],
        "chunk_end_line": row["chunk_end_line"],
        **snippet,
        "content_hash": row["content_hash"],
        "is_latest_version": bool(row["is_latest_version"]),
        "memory_citation": memory_citation,
        "source_citation": source_citation,
        "chunk_citation": chunk_citation,
        "score": row.get("fts_score"),
    }


def search_document_chunks(
    query: str,
    *,
    database: DatabaseArgument = None,
    project_name: str | None = None,
    document_path: str | None = None,
    asset_id: int | None = None,
    document_version_id: int | None = None,
    version_scope: str = "latest",
    match_mode: str = "phrase",
    field_scope: str = "both",
    limit: int = DEFAULT_LIMIT,
    max_total_chars: int = DEFAULT_TOTAL_CHARS,
) -> dict[str, Any]:
    started = perf_counter()
    parsed = parse_search_query(query, match_mode=match_mode, field_scope=field_scope)
    project = _optional_text(project_name, "project_name")
    path_filter = _canonical_path_filter(document_path)
    asset = _optional_positive_id(asset_id, "asset_id")
    version_id = _optional_positive_id(document_version_id, "document_version_id")
    bounded_limit = _bounded_integer(limit, "limit", DEFAULT_LIMIT, MAX_LIMIT)
    char_budget = _bounded_integer(
        max_total_chars, "max_total_chars", DEFAULT_TOTAL_CHARS, MAX_TOTAL_CHARS
    )
    where, parameters = _base_query(
        project_name=project,
        document_path=path_filter,
        asset_id=asset,
        document_version_id=version_id,
        version_scope=version_scope,
    )

    with _connection(database, read_only=True) as connection:
        state = require_query_ready(connection)
        if parsed.use_short_scan:
            rows = [
                dict(row)
                for row in connection.execute(
                    BASE_CTE + SELECT_COLUMNS + JOIN_SQL + f" WHERE {where}", parameters
                )
            ]
            observed_rows: list[tuple[dict[str, Any], int]] = []
            for row in rows:
                matched, position = _matches_scan(row, parsed)
                if matched:
                    observed_rows.append((row, position))
            observed_rows.sort(
                key=lambda item: (
                    item[1],
                    -item[0]["is_latest_version"],
                    -item[0]["document_version_id"],
                    item[0]["chunk_index"],
                    item[0]["chunk_id"],
                )
            )
            total_observed = len(observed_rows)
            selected_rows = [row for row, _ in observed_rows[:bounded_limit]]
            backend = "short_query_scan"
        else:
            fts_where = "document_chunks_fts MATCH ? AND " + where
            fts_parameters = [parsed.fts_expression, *parameters]
            fts_join = (
                "FROM document_chunks_fts\n"
                "JOIN document_chunks AS dc ON dc.id = document_chunks_fts.rowid\n"
                + JOIN_SQL.replace("FROM document_chunks AS dc\n", "")
            )
            total_observed = connection.execute(
                BASE_CTE
                + "SELECT COUNT(*) "
                + fts_join
                + f" WHERE {fts_where}",
                fts_parameters,
            ).fetchone()[0]
            fts_columns = SELECT_COLUMNS.replace(
                "SELECT\n", "SELECT\n    bm25(document_chunks_fts) AS fts_score,\n", 1
            )
            selected_rows = [
                dict(row)
                for row in connection.execute(
                    BASE_CTE
                    + fts_columns
                    + fts_join
                    + f" WHERE {fts_where} "
                    + "ORDER BY bm25(document_chunks_fts) ASC, "
                    + "is_latest_version DESC, dv.id DESC, dc.chunk_index ASC, dc.id ASC "
                    + "LIMIT ?",
                    [*fts_parameters, bounded_limit],
                )
            ]
            backend = "fts5_trigram"

    results: list[dict[str, Any]] = []
    returned_chars = 0
    for row in selected_rows:
        item = _result(row, parsed)
        remaining = char_budget - returned_chars
        if remaining <= 0:
            break
        if len(item["snippet"]) > remaining:
            item["snippet"] = item["snippet"][:remaining]
            item["snippet_truncated"] = True
            item["snippet_end_line"] = item["snippet_start_line"] + item["snippet"].count("\n")
            item["source_citation"] = (
                f"[Source:{item['source_id']} {item['source_reference']}:"
                f"{item['snippet_start_line']}-{item['snippet_end_line']}]"
            )
            item["chunk_citation"] = (
                f"[Chunk:{item['chunk_uid']} {item['canonical_path']}:"
                f"{item['snippet_start_line']}-{item['snippet_end_line']}]"
            )
        returned_chars += len(item["snippet"])
        item["rank"] = len(results) + 1
        results.append(item)

    return {
        "status": "OK" if results else "NO_MATCH",
        "query": parsed.original,
        "search_backend": backend,
        "applied_filters": {
            "project_name": project,
            "document_path": path_filter,
            "asset_id": asset,
            "document_version_id": version_id,
            "version_scope": version_scope,
            "match_mode": match_mode,
            "field_scope": field_scope,
            "limit": bounded_limit,
            "max_total_chars": char_budget,
        },
        "version_scope": version_scope,
        "total_matches_observed": total_observed,
        "returned_count": len(results),
        "truncated": len(results) < total_observed,
        "total_returned_chars": returned_chars,
        "index_validated_at": state["validated_at"],
        "results": results,
        "duration_ms": round((perf_counter() - started) * 1000, 3),
    }
