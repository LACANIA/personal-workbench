"""Deterministic Markdown and plain-text line parser without external dependencies."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .path_policy import ValidatedDocument


PARSER_NAME = "research-memory-line-parser"
PARSER_VERSION = "1.0.0"
_ATX_HEADING = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


@dataclass(frozen=True)
class ParsedLine:
    number: int
    text: str
    heading_path: tuple[str, ...]
    is_heading: bool
    is_blank: bool
    in_fence_before: bool
    in_fence_after: bool


@dataclass(frozen=True)
class ParsedDocument:
    source: ValidatedDocument
    lines: tuple[ParsedLine, ...]
    parser_name: str = PARSER_NAME
    parser_version: str = PARSER_VERSION

    def metadata(self) -> dict[str, Any]:
        return {
            "parser_name": self.parser_name,
            "parser_version": self.parser_version,
            "line_count": len(self.lines),
            "heading_count": sum(1 for line in self.lines if line.is_heading),
            "fenced_line_count": sum(
                1 for line in self.lines if line.in_fence_before or line.in_fence_after
            ),
        }


def _logical_lines(normalized_text: str) -> list[str]:
    lines = normalized_text.split("\n")
    if normalized_text.endswith("\n"):
        lines = lines[:-1]
    return lines or [""]


def parse_document(document: ValidatedDocument) -> ParsedDocument:
    """Parse headings and fenced-code boundaries while retaining each original line."""
    is_markdown = document.extension in {".md", ".markdown"}
    heading_levels: list[str | None] = [None] * 6
    fence_character: str | None = None
    fence_length = 0
    parsed: list[ParsedLine] = []

    for number, text in enumerate(_logical_lines(document.normalized_text), start=1):
        in_before = fence_character is not None
        fence_match = _FENCE.match(text) if is_markdown else None
        is_heading = False

        if fence_match is not None:
            marker = fence_match.group(1)
            if fence_character is None:
                fence_character = marker[0]
                fence_length = len(marker)
            elif marker[0] == fence_character and len(marker) >= fence_length:
                fence_character = None
                fence_length = 0
        elif fence_character is None and is_markdown:
            heading_match = _ATX_HEADING.match(text)
            if heading_match is not None:
                level = len(heading_match.group(1))
                title = heading_match.group(2).strip()
                heading_levels[level - 1] = title
                for index in range(level, 6):
                    heading_levels[index] = None
                is_heading = True

        heading_path = tuple(value for value in heading_levels if value is not None)
        parsed.append(
            ParsedLine(
                number=number,
                text=text,
                heading_path=heading_path,
                is_heading=is_heading,
                is_blank=text.strip() == "",
                in_fence_before=in_before,
                in_fence_after=fence_character is not None,
            )
        )

    return ParsedDocument(source=document, lines=tuple(parsed))
