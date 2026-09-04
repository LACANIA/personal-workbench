"""Append-only, content-free JSONL audit events for document ingestion."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ingest_manifest import utc_now


AUDIT_PATH = Path(__file__).resolve().parent / "audit" / "ingest-audit.jsonl"


def append_audit(event: dict[str, Any], path: str | Path = AUDIT_PATH) -> Path:
    target = Path(path).resolve(strict=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    safe_event = {
        "timestamp": event.get("timestamp", utc_now()),
        "mode": event.get("mode"),
        "database_role": event.get("database_role"),
        "project_name": event.get("project_name"),
        "canonical_path": event.get("canonical_path"),
        "content_hash": event.get("content_hash"),
        "manifest_hash": event.get("manifest_hash"),
        "status": event.get("status"),
        "source_id": event.get("source_id"),
        "asset_id": event.get("asset_id"),
        "version_id": event.get("version_id"),
        "chunk_count": event.get("chunk_count"),
        "backup_manifest_path": event.get("backup_manifest_path"),
        "error_code": event.get("error_code"),
        "duration_ms": event.get("duration_ms"),
    }
    with target.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(safe_event, ensure_ascii=False, separators=(",", ":")) + "\n")
    return target
