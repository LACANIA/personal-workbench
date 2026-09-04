"""Reviewed Manifest serialization and integrity checks."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .errors import IngestError


MANIFEST_VERSION = 1
MANIFEST_ROOT = Path(__file__).resolve().parent / "manifests"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_manifest(payload: dict[str, Any], directory: str | Path | None = None) -> dict[str, Any]:
    root = MANIFEST_ROOT if directory is None else Path(directory)
    root = root.resolve(strict=False)
    root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = root / f"ingest-{timestamp}-{uuid4().hex[:8]}.manifest.json"
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    path.write_bytes(encoded)
    return {
        "manifest_path": str(path.resolve(strict=True)),
        "manifest_sha256": hashlib.sha256(encoded).hexdigest(),
        "manifest": payload,
    }


def load_verified_manifest(path: str | Path, expected_sha256: str) -> tuple[Path, dict[str, Any]]:
    candidate = Path(path).resolve(strict=True)
    expected = expected_sha256.strip().casefold() if isinstance(expected_sha256, str) else ""
    if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
        raise IngestError("MANIFEST_SHA_INVALID", "manifest SHA-256 must contain 64 hex characters")
    actual = sha256_file(candidate)
    if actual != expected:
        raise IngestError(
            "MANIFEST_SHA_MISMATCH",
            "manifest SHA-256 does not match",
            expected=expected,
            actual=actual,
        )
    try:
        payload = json.loads(candidate.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise IngestError("MANIFEST_INVALID", "manifest is not valid UTF-8 JSON") from exc
    if payload.get("manifest_version") != MANIFEST_VERSION:
        raise IngestError("MANIFEST_VERSION_UNSUPPORTED", "unsupported ingest Manifest version")
    return candidate, payload
