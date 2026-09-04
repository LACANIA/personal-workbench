"""Deterministic line-range chunking with complete, non-overlapping coverage."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Mapping

from .document_parser import ParsedDocument
from .errors import IngestError


CHUNKER_NAME = "research-memory-heading-line-chunker"
CHUNKER_VERSION = "1.0.0"
DEFAULT_CHUNKING_CONFIG = {
    "max_lines": 120,
    "max_chars": 8000,
    "prefer_heading_boundaries": True,
    "prefer_blank_boundaries": True,
    "avoid_fenced_code_splits": True,
}


def canonical_config(config: Mapping[str, Any] | None = None) -> dict[str, Any]:
    value = {**DEFAULT_CHUNKING_CONFIG, **({} if config is None else dict(config))}
    for field in ("max_lines", "max_chars"):
        if isinstance(value[field], bool) or not isinstance(value[field], int) or value[field] <= 0:
            raise IngestError("CHUNK_CONFIG_INVALID", f"{field} must be a positive integer")
    for field in (
        "prefer_heading_boundaries",
        "prefer_blank_boundaries",
        "avoid_fenced_code_splits",
    ):
        if not isinstance(value[field], bool):
            raise IngestError("CHUNK_CONFIG_INVALID", f"{field} must be a boolean")
    return value


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def make_chunk_uid(content_hash: str, start_line: int, end_line: int, chunk_hash: str) -> str:
    payload = f"{content_hash}\n{start_line}\n{end_line}\n{chunk_hash}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


@dataclass(frozen=True)
class DocumentChunk:
    chunk_uid: str
    chunk_index: int
    heading_path: tuple[str, ...]
    start_line: int
    end_line: int
    content_hash: str
    content: str
    char_count: int
    metadata: dict[str, Any]

    def manifest_preview(self, preview_chars: int = 240) -> dict[str, Any]:
        preview = self.content[:preview_chars]
        return {
            "chunk_uid": self.chunk_uid,
            "chunk_index": self.chunk_index,
            "heading_path": list(self.heading_path),
            "start_line": self.start_line,
            "end_line": self.end_line,
            "content_hash": self.content_hash,
            "char_count": self.char_count,
            "metadata": self.metadata,
            "preview": preview,
            "preview_truncated": len(self.content) > preview_chars,
        }


def _hard_boundary(parsed: ParsedDocument, start: int, config: dict[str, Any]) -> int:
    max_lines = config["max_lines"]
    max_chars = config["max_chars"]
    end = start
    chars = 0
    final_index = len(parsed.lines) - 1
    while end <= final_index:
        addition = len(parsed.lines[end].text) + (1 if end > start else 0)
        if end > start and (end - start + 1 > max_lines or chars + addition > max_chars):
            break
        chars += addition
        end += 1
    return max(start, end - 1)


def _preferred_boundary(
    parsed: ParsedDocument, start: int, hard_end: int, config: dict[str, Any]
) -> int:
    if hard_end >= len(parsed.lines) - 1:
        return hard_end
    if config["prefer_heading_boundaries"]:
        for index in range(hard_end + 1, start, -1):
            if parsed.lines[index].is_heading and not parsed.lines[index].in_fence_before:
                return index - 1
    if config["prefer_blank_boundaries"]:
        for index in range(hard_end, start, -1):
            line = parsed.lines[index]
            if line.is_blank and not line.in_fence_before and not line.in_fence_after:
                return index
    return hard_end


def _extend_past_fence(parsed: ParsedDocument, end: int, config: dict[str, Any]) -> int:
    if not config["avoid_fenced_code_splits"] or not parsed.lines[end].in_fence_after:
        return end
    final_index = len(parsed.lines) - 1
    while end < final_index and parsed.lines[end].in_fence_after:
        end += 1
    return end


def chunk_document(
    parsed: ParsedDocument, config: Mapping[str, Any] | None = None
) -> tuple[list[DocumentChunk], dict[str, Any]]:
    settings = canonical_config(config)
    chunks: list[DocumentChunk] = []
    start = 0
    while start < len(parsed.lines):
        hard_end = _hard_boundary(parsed, start, settings)
        selected_end = _preferred_boundary(parsed, start, hard_end, settings)
        selected_end = _extend_past_fence(parsed, selected_end, settings)
        lines = parsed.lines[start : selected_end + 1]
        content = "\n".join(line.text for line in lines)
        content_hash = _sha256_text(content)
        start_line = start + 1
        end_line = selected_end + 1
        metadata = {
            "line_count": len(lines),
            "contains_fenced_code": any(
                line.in_fence_before or line.in_fence_after for line in lines
            ),
            "exceeds_max_lines": len(lines) > settings["max_lines"],
            "exceeds_max_chars": len(content) > settings["max_chars"],
            "boundary_extended_for_fence": selected_end > hard_end,
        }
        chunks.append(
            DocumentChunk(
                chunk_uid=make_chunk_uid(
                    parsed.source.content_hash, start_line, end_line, content_hash
                ),
                chunk_index=len(chunks),
                heading_path=lines[0].heading_path,
                start_line=start_line,
                end_line=end_line,
                content_hash=content_hash,
                content=content,
                char_count=len(content),
                metadata=metadata,
            )
        )
        start = selected_end + 1
    validate_chunks(parsed, chunks)
    return chunks, settings


def validate_chunks(parsed: ParsedDocument, chunks: list[DocumentChunk]) -> None:
    if not chunks:
        raise IngestError("CHUNK_COVERAGE_INVALID", "document has no chunks")
    expected_start = 1
    for expected_index, chunk in enumerate(chunks):
        if chunk.chunk_index != expected_index:
            raise IngestError("CHUNK_ORDER_INVALID", "chunk_index sequence is invalid")
        if chunk.start_line != expected_start:
            code = "CHUNK_OVERLAP" if chunk.start_line < expected_start else "CHUNK_GAP"
            raise IngestError(code, "chunk line ranges are not contiguous")
        if chunk.end_line < chunk.start_line or chunk.end_line > len(parsed.lines):
            raise IngestError("CHUNK_RANGE_INVALID", "chunk line range is invalid")
        expected_content = "\n".join(
            line.text for line in parsed.lines[chunk.start_line - 1 : chunk.end_line]
        )
        if chunk.content != expected_content or chunk.content_hash != _sha256_text(expected_content):
            raise IngestError("CHUNK_HASH_MISMATCH", "chunk content or hash differs from source lines")
        expected_uid = make_chunk_uid(
            parsed.source.content_hash,
            chunk.start_line,
            chunk.end_line,
            chunk.content_hash,
        )
        if chunk.chunk_uid != expected_uid:
            raise IngestError("CHUNK_UID_MISMATCH", "chunk UID is not deterministic")
        expected_start = chunk.end_line + 1
    if expected_start != len(parsed.lines) + 1:
        raise IngestError("CHUNK_GAP", "chunks do not cover the final source line")


def chunk_signature(chunks: list[DocumentChunk]) -> str:
    compact = [
        {
            "uid": chunk.chunk_uid,
            "index": chunk.chunk_index,
            "start": chunk.start_line,
            "end": chunk.end_line,
            "hash": chunk.content_hash,
        }
        for chunk in chunks
    ]
    return _sha256_text(json.dumps(compact, ensure_ascii=False, sort_keys=True))
