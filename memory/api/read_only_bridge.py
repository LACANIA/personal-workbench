"""JSON bridge exposing only read-only Research Memory operations."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from time import perf_counter
from typing import Any


MY_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(MY_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(MY_AGENT_ROOT))

from memory.api.agent_interface import get_project_context, query_memory  # noqa: E402
from memory.api.memory_api import (  # noqa: E402
    MemoryNotFoundError,
    MemoryValidationError,
    ResearchMemoryError,
)
from memory.search.chunk_query import (  # noqa: E402
    get_document_chunk,
    search_document_chunks,
)


def _required_string(payload: dict[str, Any], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise MemoryValidationError(f"{field} must be a non-empty string")
    return value.strip()


def _optional_string(payload: dict[str, Any], field: str) -> str | None:
    value = payload.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise MemoryValidationError(f"{field} must be a non-empty string when provided")
    return value.strip()


def _optional_integer(payload: dict[str, Any], field: str, default: int) -> int:
    value = payload.get(field, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise MemoryValidationError(f"{field} must be an integer")
    return value


def _optional_nullable_integer(payload: dict[str, Any], field: str) -> int | None:
    value = payload.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise MemoryValidationError(f"{field} must be an integer when provided")
    return value


def _optional_boolean(payload: dict[str, Any], field: str, default: bool = False) -> bool:
    value = payload.get(field, default)
    if not isinstance(value, bool):
        raise MemoryValidationError(f"{field} must be a boolean")
    return value


def execute_request(payload: dict[str, Any], database: Path) -> dict[str, Any]:
    """Execute one allowlisted operation through the public Agent interface."""
    operation = _required_string(payload, "operation")
    started = perf_counter()

    if operation == "query_memory":
        entity_types = payload.get("entity_types")
        if entity_types is not None and not isinstance(entity_types, list):
            raise MemoryValidationError("entity_types must be an array")
        result = query_memory(
            _required_string(payload, "query"),
            database=database,
            read_only=True,
            entity_types=entity_types,
            project_name=_optional_string(payload, "project_name"),
            limit_per_type=_optional_integer(payload, "limit_per_type", 20),
            include_sources=_optional_boolean(payload, "include_sources"),
        )
    elif operation == "get_project_context":
        result = get_project_context(
            _required_string(payload, "project_name"),
            database=database,
            read_only=True,
            include_sources=_optional_boolean(payload, "include_sources"),
            limit_per_entity=_optional_integer(payload, "limit_per_entity", 20),
        )
    elif operation == "search_document_chunks":
        result = search_document_chunks(
            _required_string(payload, "query"),
            database=database,
            project_name=_optional_string(payload, "project_name"),
            document_path=_optional_string(payload, "document_path"),
            asset_id=_optional_nullable_integer(payload, "asset_id"),
            document_version_id=_optional_nullable_integer(payload, "document_version_id"),
            version_scope=_optional_string(payload, "version_scope") or "latest",
            match_mode=_optional_string(payload, "match_mode") or "phrase",
            field_scope=_optional_string(payload, "field_scope") or "both",
            limit=_optional_integer(payload, "limit", 8),
            max_total_chars=_optional_integer(payload, "max_total_chars", 4000),
        )
    elif operation == "get_document_chunk":
        result = get_document_chunk(
            _required_string(payload, "chunk_uid"),
            database=database,
            include_content=_optional_boolean(payload, "include_content", True),
        )
    else:
        raise MemoryValidationError(f"unsupported read-only operation: {operation}")

    return {
        "ok": True,
        "operation": operation,
        "duration_ms": round((perf_counter() - started) * 1000, 3),
        "result": result,
    }


def _error_payload(error: Exception) -> dict[str, Any]:
    if isinstance(error, MemoryNotFoundError):
        code = "MEMORY_NOT_FOUND"
    elif isinstance(error, MemoryValidationError):
        code = "MEMORY_VALIDATION_ERROR"
    elif isinstance(error, ResearchMemoryError):
        code = "MEMORY_STORAGE_ERROR"
    else:
        code = "MEMORY_BRIDGE_ERROR"
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": str(error),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Research Memory JSON bridge.")
    parser.add_argument("--database", type=Path, required=True)
    args = parser.parse_args()

    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise MemoryValidationError("request payload must be a JSON object")
        response = execute_request(payload, args.database)
    except Exception as error:  # The process boundary converts failures to JSON.
        response = _error_payload(error)

    print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
