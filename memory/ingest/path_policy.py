"""Windows-aware allowlist and file validation for one explicit input file."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import IngestError


DEFAULT_POLICY_PATH = Path(
    os.environ.get("PERSONAL_PATH_POLICY_PATH")
    or Path(__file__).resolve().parents[2] / "config" / "personal-path-policy.example.yaml"
)
SUPPORTED_EXTENSIONS = {".md", ".markdown", ".txt"}
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_FILE_LINES = 250_000
_DRIVE_RELATIVE = re.compile(r"^[A-Za-z]:[^\\/]")
_DRIVE_ROOT = re.compile(r"^[A-Za-z]:[\\/]")


def _comparison_path(value: str | Path) -> str:
    return os.path.normcase(os.path.normpath(str(value))).rstrip("\\/")


def _unsafe_namespace(value: str) -> bool:
    windows = value.replace("/", "\\")
    return windows.startswith("\\\\") or bool(_DRIVE_RELATIVE.match(windows))


def _has_alternate_data_stream(value: str) -> bool:
    windows = value.replace("/", "\\")
    remainder = windows[2:] if _DRIVE_ROOT.match(windows) else windows
    return ":" in remainder


def _is_within(target: Path, root: Path) -> bool:
    target_value = _comparison_path(target)
    root_value = _comparison_path(root)
    try:
        return os.path.commonpath((target_value, root_value)) == root_value
    except ValueError:
        return False


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _looks_binary(value: bytes) -> bool:
    if b"\x00" in value:
        return True
    if not value:
        return False
    controls = sum(
        1 for byte in value if byte < 32 and byte not in (9, 10, 12, 13)
    )
    return controls / len(value) > 0.02


@dataclass(frozen=True)
class ValidatedDocument:
    requested_path: str
    canonical_path: str
    extension: str
    raw_bytes: bytes
    text: str
    normalized_text: str
    text_encoding: str
    content_hash: str
    normalized_text_hash: str
    byte_count: int
    line_count: int
    had_final_newline: bool

    def metadata(self) -> dict[str, Any]:
        return {
            "requested_path": self.requested_path,
            "canonical_path": self.canonical_path,
            "extension": self.extension,
            "text_encoding": self.text_encoding,
            "content_hash": self.content_hash,
            "normalized_text_hash": self.normalized_text_hash,
            "byte_count": self.byte_count,
            "line_count": self.line_count,
            "had_final_newline": self.had_final_newline,
        }


class PathPolicy:
    """Allow only existing files whose resolved target remains below configured roots."""

    def __init__(self, policy_path: Path, allowed_roots: tuple[Path, ...]) -> None:
        self.policy_path = policy_path
        self.allowed_roots = allowed_roots

    @classmethod
    def load(cls, policy_path: str | Path = DEFAULT_POLICY_PATH) -> "PathPolicy":
        path = Path(policy_path).expanduser().resolve(strict=True)
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise IngestError("PATH_POLICY_INVALID", f"cannot read path policy: {path}") from exc
        roots = payload.get("allowedRoots") if isinstance(payload, dict) else None
        if not isinstance(roots, list) or not roots:
            raise IngestError("PATH_POLICY_INVALID", "allowedRoots must contain at least one path")
        canonical_roots: list[Path] = []
        for configured in roots:
            if not isinstance(configured, str) or not configured.strip():
                raise IngestError("PATH_POLICY_INVALID", "allowedRoots entries must be strings")
            if _unsafe_namespace(configured) or _has_alternate_data_stream(configured):
                raise IngestError("PATH_POLICY_INVALID", f"unsafe allowed root: {configured}")
            root = Path(configured).resolve(strict=True)
            if not root.is_dir():
                raise IngestError("PATH_POLICY_INVALID", f"allowed root is not a directory: {root}")
            if all(_comparison_path(root) != _comparison_path(item) for item in canonical_roots):
                canonical_roots.append(root)
        return cls(path, tuple(canonical_roots))

    def _assert_allowed(self, canonical: Path, requested: str) -> None:
        if not any(_is_within(canonical, root) for root in self.allowed_roots):
            raise IngestError(
                "PATH_POLICY_DENIED",
                f"path resolves outside allowed roots: {requested}",
                canonical_path=str(canonical),
                allowed_roots=[str(root) for root in self.allowed_roots],
            )

    def resolve_document(self, value: str | Path, *, base_directory: str | Path | None = None) -> Path:
        requested = str(value)
        if not requested.strip():
            raise IngestError("PATH_INVALID", "file path must be a non-empty string")
        if _unsafe_namespace(requested):
            raise IngestError("PATH_POLICY_DENIED", "UNC and device paths are not permitted")
        if _has_alternate_data_stream(requested):
            raise IngestError("PATH_POLICY_DENIED", "NTFS alternate data streams are not permitted")
        base = Path.cwd() if base_directory is None else Path(base_directory)
        candidate = Path(requested)
        if not candidate.is_absolute():
            candidate = base / candidate
        try:
            canonical = candidate.resolve(strict=True)
        except FileNotFoundError as exc:
            raise IngestError("PATH_NOT_FOUND", f"file does not exist: {candidate}") from exc
        self._assert_allowed(canonical, requested)
        if not canonical.is_file():
            raise IngestError("PATH_TYPE_MISMATCH", f"path is not a regular file: {canonical}")
        extension = canonical.suffix.casefold()
        if extension not in SUPPORTED_EXTENSIONS:
            raise IngestError("UNSUPPORTED_EXTENSION", f"unsupported document extension: {extension}")
        return canonical

    def read_document(
        self,
        value: str | Path,
        *,
        base_directory: str | Path | None = None,
        max_bytes: int = MAX_FILE_BYTES,
        max_lines: int = MAX_FILE_LINES,
    ) -> ValidatedDocument:
        canonical = self.resolve_document(value, base_directory=base_directory)
        before = canonical.stat()
        if before.st_size > max_bytes:
            raise IngestError(
                "FILE_TOO_LARGE", f"file exceeds {max_bytes} bytes", byte_count=before.st_size
            )
        try:
            with canonical.open("rb") as handle:
                opened = os.fstat(handle.fileno())
                raw = handle.read(max_bytes + 1)
        except OSError as exc:
            raise IngestError("FILE_READ_FAILED", f"cannot read file: {canonical}") from exc
        after = canonical.stat()
        before_identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        opened_identity = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
        after_identity = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        if before_identity != opened_identity or opened_identity != after_identity:
            raise IngestError("FILE_CHANGED_DURING_READ", f"file changed during read: {canonical}")
        if len(raw) > max_bytes:
            raise IngestError("FILE_TOO_LARGE", f"file exceeds {max_bytes} bytes")
        if _looks_binary(raw):
            code = "NUL_BYTE_DENIED" if b"\x00" in raw else "BINARY_CONTENT_DENIED"
            raise IngestError(code, f"binary content is not permitted: {canonical}")
        encoding = "utf-8-sig" if raw.startswith(b"\xef\xbb\xbf") else "utf-8"
        try:
            text = raw.decode(encoding, errors="strict")
        except UnicodeDecodeError as exc:
            raise IngestError("INVALID_UTF8", f"file is not valid UTF-8: {canonical}") from exc
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        lines = normalized.split("\n")
        had_final_newline = normalized.endswith("\n")
        if had_final_newline:
            lines = lines[:-1]
        if not lines:
            lines = [""]
        if len(lines) > max_lines:
            raise IngestError("FILE_TOO_MANY_LINES", f"file exceeds {max_lines} lines")
        return ValidatedDocument(
            requested_path=str(value),
            canonical_path=str(canonical),
            extension=canonical.suffix.casefold(),
            raw_bytes=raw,
            text=text,
            normalized_text=normalized,
            text_encoding=encoding,
            content_hash=_sha256_bytes(raw),
            normalized_text_hash=_sha256_bytes(normalized.encode("utf-8")),
            byte_count=len(raw),
            line_count=len(lines),
            had_final_newline=had_final_newline,
        )
