"""Safe construction of FTS5 expressions from untrusted model text."""

from __future__ import annotations

import re
from dataclasses import dataclass

from memory.api.memory_api import MemoryValidationError


MAX_QUERY_CHARS = 256
MATCH_MODES = {"phrase", "all", "any"}
FIELD_SCOPES = {"content", "heading", "both"}
_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class ParsedSearchQuery:
    original: str
    terms: tuple[str, ...]
    match_mode: str
    field_scope: str
    fts_expression: str | None
    use_short_scan: bool


def _quoted(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def parse_search_query(
    query: str, *, match_mode: str = "phrase", field_scope: str = "both"
) -> ParsedSearchQuery:
    if not isinstance(query, str) or not query.strip():
        raise MemoryValidationError("query must be a non-empty string")
    value = query.strip()
    if "\x00" in value:
        raise MemoryValidationError("query must not contain NUL characters")
    if len(value) > MAX_QUERY_CHARS:
        raise MemoryValidationError(f"query must not exceed {MAX_QUERY_CHARS} characters")
    if match_mode not in MATCH_MODES:
        raise MemoryValidationError("match_mode must be phrase, all, or any")
    if field_scope not in FIELD_SCOPES:
        raise MemoryValidationError("field_scope must be content, heading, or both")

    terms = (value,) if match_mode == "phrase" else tuple(
        term for term in _WHITESPACE.split(value) if term
    )
    if not terms:
        raise MemoryValidationError("query does not contain searchable text")
    use_short_scan = any(len(term) < 3 for term in terms)
    if use_short_scan:
        expression = None
    else:
        operator = " AND " if match_mode == "all" else " OR "
        expression = _quoted(value) if match_mode == "phrase" else operator.join(
            _quoted(term) for term in terms
        )
        if field_scope == "content":
            expression = f"content : ({expression})"
        elif field_scope == "heading":
            expression = f"heading_path_json : ({expression})"

    return ParsedSearchQuery(
        original=value,
        terms=terms,
        match_mode=match_mode,
        field_scope=field_scope,
        fts_expression=expression,
        use_short_scan=use_short_scan,
    )
