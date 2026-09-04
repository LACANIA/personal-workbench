"""Offline preview, reviewed commit, and read APIs for document ingestion."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from time import perf_counter
from typing import Any, Mapping, Sequence

from memory.database.backup_db import backup_database
from memory.database.init_db import MEMORY_ROOT, resolve_database_path
from memory.database.validate_db import inspect_database, sha256_file
from memory.database.verify_backup import verify_backup

from .document_chunker import (
    CHUNKER_NAME,
    CHUNKER_VERSION,
    DocumentChunk,
    chunk_document,
    chunk_signature,
    validate_chunks,
)
from .document_parser import ParsedDocument, parse_document
from .errors import IngestError
from .ingest_audit import append_audit
from .ingest_manifest import (
    MANIFEST_VERSION,
    load_verified_manifest,
    utc_now,
    write_manifest,
)
from .path_policy import DEFAULT_POLICY_PATH, PathPolicy


PRODUCTION_DATABASE = (MEMORY_ROOT / "database" / "research_memory.db").resolve(strict=False)
CANONICAL_TEST_DATABASE = (MEMORY_ROOT / "tests" / "test_research_memory.db").resolve(
    strict=False
)
REQUIRED_SCHEMA_VERSION = 4
REQUIRED_V3_TABLES = {
    "document_assets",
    "document_versions",
    "document_chunks",
    "ingest_runs",
}


def _database_role(path: Path) -> str:
    if path == PRODUCTION_DATABASE:
        return "production"
    if path == CANONICAL_TEST_DATABASE:
        return "test"
    return "test-fixture"


def _required_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise IngestError("INGEST_ARGUMENT_INVALID", f"{field} must be a non-empty string")
    return value.strip()


def _limit(value: int, field: str, maximum: int = 1000) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise IngestError(
            "INGEST_ARGUMENT_INVALID", f"{field} must be an integer from 1 to {maximum}"
        )
    return value


def _json_object(value: str, field: str) -> dict[str, Any]:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise IngestError("DATABASE_JSON_INVALID", f"{field} is not valid JSON") from exc
    if not isinstance(decoded, dict):
        raise IngestError("DATABASE_JSON_INVALID", f"{field} must contain a JSON object")
    return decoded


def _json_array(value: str, field: str) -> list[Any]:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise IngestError("DATABASE_JSON_INVALID", f"{field} is not valid JSON") from exc
    if not isinstance(decoded, list):
        raise IngestError("DATABASE_JSON_INVALID", f"{field} must contain a JSON array")
    return decoded


def _open_database(path: Path, *, read_only: bool) -> sqlite3.Connection:
    if read_only:
        connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=5.0)
    else:
        connection = sqlite3.connect(path, timeout=5.0, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    if read_only:
        connection.execute("PRAGMA query_only = ON")
    return connection


def _validate_database(path: Path) -> dict[str, Any]:
    state = inspect_database(path)
    if state["user_version"] != REQUIRED_SCHEMA_VERSION:
        raise IngestError(
            "DATABASE_SCHEMA_MISMATCH",
            f"database must use schema v{REQUIRED_SCHEMA_VERSION}",
            found=state["user_version"],
        )
    missing = sorted(REQUIRED_V3_TABLES.difference(state["tables"]))
    if missing:
        raise IngestError("DATABASE_SCHEMA_MISMATCH", "v3 tables are missing", tables=missing)
    if not state["valid"]:
        raise IngestError("DATABASE_INTEGRITY_FAILED", "database integrity validation failed")
    return state


def _project(connection: sqlite3.Connection, project_name: str) -> dict[str, Any]:
    row = connection.execute(
        "SELECT * FROM projects WHERE name = ?", (_required_text(project_name, "project_name"),)
    ).fetchone()
    if row is None:
        raise IngestError("PROJECT_NOT_FOUND", f"project does not exist: {project_name}")
    return dict(row)


def _derive_document_type(extension: str, explicit: str | None) -> str:
    if explicit is not None:
        return _required_text(explicit, "document_type")
    return "markdown_report" if extension in {".md", ".markdown"} else "text_document"


def _derive_source_type(document_type: str) -> str:
    return "report" if "report" in document_type.casefold() else "file"


def _existing_state(
    connection: sqlite3.Connection,
    *,
    project_id: int,
    canonical_path: str,
    content_hash: str,
) -> dict[str, Any]:
    source = connection.execute(
        """
        SELECT * FROM sources
        WHERE project_id = ? AND canonical_path = ? COLLATE NOCASE AND content_hash = ?
        ORDER BY id ASC LIMIT 1
        """,
        (project_id, canonical_path, content_hash),
    ).fetchone()
    asset = connection.execute(
        """
        SELECT * FROM document_assets
        WHERE project_id = ? AND canonical_path = ? COLLATE NOCASE
        ORDER BY id ASC LIMIT 1
        """,
        (project_id, canonical_path),
    ).fetchone()
    version = None
    if asset is not None:
        version = connection.execute(
            """
            SELECT * FROM document_versions
            WHERE asset_id = ? AND content_hash = ?
            ORDER BY id ASC LIMIT 1
            """,
            (asset["id"], content_hash),
        ).fetchone()
    return {
        "source": None if source is None else dict(source),
        "asset": None if asset is None else dict(asset),
        "version": None if version is None else dict(version),
    }


def _preview_payload(
    *,
    database_path: Path,
    database_role: str,
    database_before: dict[str, Any],
    policy: PathPolicy,
    project: dict[str, Any],
    parsed: ParsedDocument,
    chunks: list[DocumentChunk],
    chunking_config: dict[str, Any],
    document_type: str,
    title: str,
    summary: str,
    source_version: str,
    existing: dict[str, Any],
    metrics: dict[str, float],
) -> dict[str, Any]:
    duplicate = "already_imported" if existing["version"] is not None else (
        "new_version" if existing["asset"] is not None else "new_asset"
    )
    operations = [] if duplicate == "already_imported" else [
        "create_or_reuse_source",
        "create_or_reuse_document_asset",
        "create_document_memory_record",
        "link_document_record_to_source",
        "create_document_version",
        "create_document_chunks",
        "write_ingest_run",
    ]
    return {
        "manifest_version": MANIFEST_VERSION,
        "created_at": utc_now(),
        "mode": "dry-run",
        "database_path": str(database_path),
        "database_role": database_role,
        "project_id": project["id"],
        "project_name": project["name"],
        "canonical_path": parsed.source.canonical_path,
        "document_type": document_type,
        "source_type": _derive_source_type(document_type),
        "title": title,
        "summary": summary,
        "summary_origin": "explicit_deterministic_input",
        "source_version": source_version,
        "content_hash": parsed.source.content_hash,
        "normalized_text_hash": parsed.source.normalized_text_hash,
        "byte_count": parsed.source.byte_count,
        "line_count": parsed.source.line_count,
        "had_final_newline": parsed.source.had_final_newline,
        "text_encoding": parsed.source.text_encoding,
        "parser_name": parsed.parser_name,
        "parser_version": parsed.parser_version,
        "chunker_name": CHUNKER_NAME,
        "chunker_version": CHUNKER_VERSION,
        "chunking_config": chunking_config,
        "chunk_signature": chunk_signature(chunks),
        "chunk_count": len(chunks),
        "chunks": [chunk.manifest_preview() for chunk in chunks],
        "duplicate_status": duplicate,
        "existing_source_id": None if existing["source"] is None else existing["source"]["id"],
        "existing_asset_id": None if existing["asset"] is None else existing["asset"]["id"],
        "existing_version_id": None if existing["version"] is None else existing["version"]["id"],
        "proposed_operations": operations,
        "database_sha256_before": database_before["sha256"],
        "database_size_before": database_before["size_bytes"],
        "policy_path": str(policy.policy_path),
        "allowed_roots": [str(root) for root in policy.allowed_roots],
        "preview_metrics_ms": metrics,
    }


def preview_document_ingest(
    *,
    database: str | Path,
    project_name: str,
    file_path: str | Path,
    source_version: str,
    summary: str,
    title: str | None = None,
    document_type: str | None = None,
    policy_path: str | Path = DEFAULT_POLICY_PATH,
    base_directory: str | Path | None = None,
    chunking_config: Mapping[str, Any] | None = None,
    manifest_directory: str | Path | None = None,
) -> dict[str, Any]:
    """Validate and preview one explicit file without changing the database."""
    started = perf_counter()
    audit: dict[str, Any] = {"mode": "dry-run", "status": "failed"}
    try:
        database_path = resolve_database_path(database)
        role = _database_role(database_path)
        audit["database_role"] = role
        before_stat = database_path.stat()
        before = _validate_database(database_path)

        read_started = perf_counter()
        policy = PathPolicy.load(policy_path)
        document = policy.read_document(file_path, base_directory=base_directory)
        read_ms = (perf_counter() - read_started) * 1000
        audit["canonical_path"] = document.canonical_path
        audit["content_hash"] = document.content_hash

        parse_started = perf_counter()
        parsed = parse_document(document)
        parse_ms = (perf_counter() - parse_started) * 1000

        chunk_started = perf_counter()
        chunks, settings = chunk_document(parsed, chunking_config)
        chunk_ms = (perf_counter() - chunk_started) * 1000

        database_started = perf_counter()
        with closing(_open_database(database_path, read_only=True)) as connection:
            project = _project(connection, project_name)
            existing = _existing_state(
                connection,
                project_id=project["id"],
                canonical_path=document.canonical_path,
                content_hash=document.content_hash,
            )
        query_ms = (perf_counter() - database_started) * 1000
        audit["project_name"] = project["name"]

        after = inspect_database(database_path)
        after_stat = database_path.stat()
        if (
            before["sha256"] != after["sha256"]
            or before_stat.st_size != after_stat.st_size
            or before_stat.st_mtime_ns != after_stat.st_mtime_ns
        ):
            raise IngestError("DRY_RUN_DATABASE_CHANGED", "database changed during dry-run")

        manifest_started = perf_counter()
        metrics = {
            "file_read": round(read_ms, 3),
            "parse": round(parse_ms, 3),
            "chunk": round(chunk_ms, 3),
            "database_query": round(query_ms, 3),
        }
        payload = _preview_payload(
            database_path=database_path,
            database_role=role,
            database_before=before,
            policy=policy,
            project=project,
            parsed=parsed,
            chunks=chunks,
            chunking_config=settings,
            document_type=_derive_document_type(document.extension, document_type),
            title=_required_text(title or Path(document.canonical_path).stem, "title"),
            summary=_required_text(summary, "summary"),
            source_version=_required_text(source_version, "source_version"),
            existing=existing,
            metrics=metrics,
        )
        written = write_manifest(payload, manifest_directory)
        manifest_ms = (perf_counter() - manifest_started) * 1000
        total_ms = (perf_counter() - started) * 1000
        audit.update(
            {
                "status": "previewed",
                "manifest_hash": written["manifest_sha256"],
                "chunk_count": len(chunks),
                "duration_ms": round(total_ms, 3),
            }
        )
        append_audit(audit)
        return {
            "status": "DRY_RUN_READY",
            "database_unchanged": True,
            "manifest_path": written["manifest_path"],
            "manifest_sha256": written["manifest_sha256"],
            "manifest": payload,
            "metrics_ms": {
                **metrics,
                "manifest": round(manifest_ms, 3),
                "total": round(total_ms, 3),
            },
        }
    except Exception as exc:
        error = exc if isinstance(exc, IngestError) else IngestError(
            "INGEST_PREVIEW_FAILED", str(exc)
        )
        audit["error_code"] = error.code
        audit["duration_ms"] = round((perf_counter() - started) * 1000, 3)
        append_audit(audit)
        raise error from exc if error is not exc else None


def _verify_manifest_replay(
    payload: dict[str, Any], policy: PathPolicy
) -> tuple[ParsedDocument, list[DocumentChunk]]:
    required = (
        "database_path",
        "project_id",
        "project_name",
        "canonical_path",
        "document_type",
        "title",
        "summary",
        "source_version",
        "content_hash",
        "normalized_text_hash",
        "chunking_config",
        "chunks",
    )
    missing = [field for field in required if field not in payload]
    if missing:
        raise IngestError("MANIFEST_INVALID", "manifest fields are missing", fields=missing)
    document = policy.read_document(payload["canonical_path"])
    parsed = parse_document(document)
    chunks, settings = chunk_document(parsed, payload["chunking_config"])
    comparisons = {
        "canonical_path": document.canonical_path,
        "content_hash": document.content_hash,
        "normalized_text_hash": document.normalized_text_hash,
        "byte_count": document.byte_count,
        "line_count": document.line_count,
        "text_encoding": document.text_encoding,
        "parser_name": parsed.parser_name,
        "parser_version": parsed.parser_version,
        "chunker_name": CHUNKER_NAME,
        "chunker_version": CHUNKER_VERSION,
        "chunking_config": settings,
        "chunk_signature": chunk_signature(chunks),
        "chunk_count": len(chunks),
        "chunks": [chunk.manifest_preview() for chunk in chunks],
    }
    mismatches = [field for field, value in comparisons.items() if payload.get(field) != value]
    if mismatches:
        code = "SOURCE_CHANGED_AFTER_PREVIEW" if any(
            field in mismatches for field in ("content_hash", "normalized_text_hash", "byte_count")
        ) else "MANIFEST_REPLAY_MISMATCH"
        raise IngestError(code, "source replay differs from reviewed Manifest", fields=mismatches)
    return parsed, chunks


def _insert_ingest_run(
    connection: sqlite3.Connection,
    *,
    project_id: int,
    canonical_path: str,
    content_hash: str,
    manifest_path: str,
    manifest_hash: str,
    status: str,
    asset_id: int | None,
    version_id: int | None,
    backup_manifest_path: str,
    started_at: str,
    completed_at: str,
) -> int:
    return connection.execute(
        """
        INSERT INTO ingest_runs(
            project_id, canonical_path, content_hash, manifest_path, manifest_hash,
            mode, status, asset_id, document_version_id, backup_manifest_path,
            started_at, completed_at, error_message
        ) VALUES (?, ?, ?, ?, ?, 'commit', ?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            project_id,
            canonical_path,
            content_hash,
            manifest_path,
            manifest_hash,
            status,
            asset_id,
            version_id,
            backup_manifest_path,
            started_at,
            completed_at,
        ),
    ).lastrowid


def _validate_persisted_chunks(
    connection: sqlite3.Connection, version_id: int, expected: Sequence[DocumentChunk]
) -> None:
    rows = connection.execute(
        """
        SELECT chunk_index, chunk_uid, start_line, end_line, content_hash, content
        FROM document_chunks WHERE document_version_id = ? ORDER BY chunk_index
        """,
        (version_id,),
    ).fetchall()
    if len(rows) != len(expected):
        raise IngestError("CHUNK_PERSISTENCE_INVALID", "persisted chunk count differs")
    for row, chunk in zip(rows, expected, strict=True):
        if (
            row["chunk_index"] != chunk.chunk_index
            or row["chunk_uid"] != chunk.chunk_uid
            or row["start_line"] != chunk.start_line
            or row["end_line"] != chunk.end_line
            or row["content_hash"] != chunk.content_hash
            or row["content"] != chunk.content
        ):
            raise IngestError("CHUNK_PERSISTENCE_INVALID", "persisted chunk differs")


def commit_document_ingest(
    *,
    manifest_path: str | Path | None,
    manifest_sha256: str | None,
    confirm_production_write: bool = False,
    _failure_point: str | None = None,
) -> dict[str, Any]:
    """Commit one reviewed Manifest after replay, backup, and a single transaction."""
    started_perf = perf_counter()
    started_at = utc_now()
    audit: dict[str, Any] = {"mode": "commit", "status": "failed"}
    backup: dict[str, Any] | None = None
    try:
        if manifest_path is None:
            raise IngestError("MANIFEST_REQUIRED", "commit requires --manifest")
        if manifest_sha256 is None:
            raise IngestError("MANIFEST_SHA_REQUIRED", "commit requires --manifest-sha256")
        manifest_file, payload = load_verified_manifest(manifest_path, manifest_sha256)
        database_path = resolve_database_path(payload.get("database_path"))
        role = _database_role(database_path)
        audit.update(
            {
                "database_role": role,
                "project_name": payload.get("project_name"),
                "canonical_path": payload.get("canonical_path"),
                "content_hash": payload.get("content_hash"),
                "manifest_hash": manifest_sha256,
            }
        )
        if role == "production" and not confirm_production_write:
            raise IngestError(
                "PRODUCTION_WRITE_CONFIRMATION_REQUIRED",
                "production commit requires --confirm-production-write",
            )
        _validate_database(database_path)
        policy = PathPolicy.load(payload.get("policy_path", DEFAULT_POLICY_PATH))
        parsed, chunks = _verify_manifest_replay(payload, policy)

        with closing(_open_database(database_path, read_only=True)) as connection:
            project = _project(connection, payload["project_name"])
            if project["id"] != payload["project_id"]:
                raise IngestError("PROJECT_ID_MISMATCH", "project ID differs from Manifest")

        backup_started = perf_counter()
        backup = backup_database(database_path, label=f"step13-ingest-{role}")
        backup_verification = verify_backup(
            backup["manifest_path"],
            expect_project=None if role == "production" else payload["project_name"],
        )
        backup_ms = (perf_counter() - backup_started) * 1000
        if not backup_verification["valid"]:
            raise IngestError("BACKUP_VERIFICATION_FAILED", "pre-commit backup is invalid")

        transaction_started = perf_counter()
        connection = _open_database(database_path, read_only=False)
        try:
            connection.execute("BEGIN IMMEDIATE")
            existing = _existing_state(
                connection,
                project_id=project["id"],
                canonical_path=parsed.source.canonical_path,
                content_hash=parsed.source.content_hash,
            )
            if existing["version"] is not None:
                completed_at = utc_now()
                run_id = _insert_ingest_run(
                    connection,
                    project_id=project["id"],
                    canonical_path=parsed.source.canonical_path,
                    content_hash=parsed.source.content_hash,
                    manifest_path=str(manifest_file),
                    manifest_hash=manifest_sha256.casefold(),
                    status="already_imported",
                    asset_id=existing["asset"]["id"],
                    version_id=existing["version"]["id"],
                    backup_manifest_path=backup["manifest_path"],
                    started_at=started_at,
                    completed_at=completed_at,
                )
                connection.execute("COMMIT")
                total_ms = (perf_counter() - started_perf) * 1000
                audit.update(
                    {
                        "status": "already_imported",
                        "source_id": existing["version"]["source_id"],
                        "asset_id": existing["asset"]["id"],
                        "version_id": existing["version"]["id"],
                        "chunk_count": existing["version"]["chunk_count"],
                        "backup_manifest_path": backup["manifest_path"],
                        "duration_ms": round(total_ms, 3),
                    }
                )
                append_audit(audit)
                return {
                    "status": "ALREADY_IMPORTED",
                    "ingest_run_id": run_id,
                    "source_id": existing["version"]["source_id"],
                    "asset_id": existing["asset"]["id"],
                    "document_version_id": existing["version"]["id"],
                    "chunk_count": existing["version"]["chunk_count"],
                    "backup": backup,
                    "backup_verification": backup_verification,
                    "metrics_ms": {
                        "backup_and_restore_verify": round(backup_ms, 3),
                        "transaction": round((perf_counter() - transaction_started) * 1000, 3),
                        "total": round(total_ms, 3),
                    },
                }

            now = utc_now()
            source = existing["source"]
            if source is None:
                source_id = connection.execute(
                    """
                    INSERT INTO sources(
                        project_id, source_type, canonical_path, external_ref, content_hash,
                        source_version, created_at, verified_at
                    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
                    """,
                    (
                        project["id"],
                        payload["source_type"],
                        parsed.source.canonical_path,
                        parsed.source.content_hash,
                        payload["source_version"],
                        now,
                        now,
                    ),
                ).lastrowid
            else:
                source_id = source["id"]

            asset = existing["asset"]
            if asset is None:
                asset_id = connection.execute(
                    """
                    INSERT INTO document_assets(
                        project_id, canonical_path, document_type, title, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        project["id"],
                        parsed.source.canonical_path,
                        payload["document_type"],
                        payload["title"],
                        now,
                        now,
                    ),
                ).lastrowid
            else:
                asset_id = asset["id"]

            document_row = connection.execute(
                """
                SELECT * FROM documents
                WHERE project_id = ? AND path = ? COLLATE NOCASE AND hash = ?
                ORDER BY id ASC LIMIT 1
                """,
                (project["id"], parsed.source.canonical_path, parsed.source.content_hash),
            ).fetchone()
            if document_row is None:
                memory_document_id = connection.execute(
                    """
                    INSERT INTO documents(project_id, path, type, summary, hash, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        project["id"],
                        parsed.source.canonical_path,
                        payload["document_type"],
                        payload["summary"],
                        parsed.source.content_hash,
                        now,
                    ),
                ).lastrowid
            else:
                memory_document_id = document_row["id"]

            link = connection.execute(
                """
                SELECT id FROM record_sources
                WHERE entity_type = 'document' AND entity_id = ? AND source_id = ?
                  AND role = 'derived_from' AND locator_type = 'line'
                  AND locator_start = 1 AND locator_end = ?
                """,
                (memory_document_id, source_id, parsed.source.line_count),
            ).fetchone()
            if link is None:
                connection.execute(
                    """
                    INSERT INTO record_sources(
                        entity_type, entity_id, source_id, role, locator_type,
                        locator_start, locator_end, locator_json, note,
                        verification_status, created_at, verified_at
                    ) VALUES ('document', ?, ?, 'derived_from', 'line', 1, ?, NULL, NULL,
                              'verified', ?, ?)
                    """,
                    (memory_document_id, source_id, parsed.source.line_count, now, now),
                )

            version_id = connection.execute(
                """
                INSERT INTO document_versions(
                    asset_id, memory_document_id, source_id, content_hash,
                    normalized_text_hash, source_version, parser_name, parser_version,
                    chunker_name, chunker_version, chunking_config_json, text_encoding,
                    byte_count, line_count, chunk_count, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    asset_id,
                    memory_document_id,
                    source_id,
                    parsed.source.content_hash,
                    parsed.source.normalized_text_hash,
                    payload["source_version"],
                    parsed.parser_name,
                    parsed.parser_version,
                    CHUNKER_NAME,
                    CHUNKER_VERSION,
                    json.dumps(payload["chunking_config"], sort_keys=True, separators=(",", ":")),
                    parsed.source.text_encoding,
                    parsed.source.byte_count,
                    parsed.source.line_count,
                    len(chunks),
                    now,
                ),
            ).lastrowid
            for chunk in chunks:
                connection.execute(
                    """
                    INSERT INTO document_chunks(
                        document_version_id, chunk_uid, chunk_index, heading_path_json,
                        start_line, end_line, content_hash, content, char_count,
                        metadata_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        version_id,
                        chunk.chunk_uid,
                        chunk.chunk_index,
                        json.dumps(list(chunk.heading_path), ensure_ascii=False, separators=(",", ":")),
                        chunk.start_line,
                        chunk.end_line,
                        chunk.content_hash,
                        chunk.content,
                        chunk.char_count,
                        json.dumps(chunk.metadata, sort_keys=True, separators=(",", ":")),
                        now,
                    ),
                )
            if _failure_point == "after_chunks":
                raise IngestError("INJECTED_TRANSACTION_FAILURE", "injected failure after chunks")

            connection.execute(
                """
                UPDATE document_assets
                SET updated_at = ?, document_type = ?, title = ?
                WHERE id = ?
                """,
                (now, payload["document_type"], payload["title"], asset_id),
            )
            _validate_persisted_chunks(connection, version_id, chunks)
            completed_at = utc_now()
            run_id = _insert_ingest_run(
                connection,
                project_id=project["id"],
                canonical_path=parsed.source.canonical_path,
                content_hash=parsed.source.content_hash,
                manifest_path=str(manifest_file),
                manifest_hash=manifest_sha256.casefold(),
                status="committed",
                asset_id=asset_id,
                version_id=version_id,
                backup_manifest_path=backup["manifest_path"],
                started_at=started_at,
                completed_at=completed_at,
            )
            foreign_keys = [list(row) for row in connection.execute("PRAGMA foreign_key_check")]
            integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
            if foreign_keys or integrity != ["ok"]:
                raise IngestError("DATABASE_INTEGRITY_FAILED", "post-commit checks failed")
            connection.execute("COMMIT")
        except Exception:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

        transaction_ms = (perf_counter() - transaction_started) * 1000
        total_ms = (perf_counter() - started_perf) * 1000
        audit.update(
            {
                "status": "committed",
                "source_id": source_id,
                "asset_id": asset_id,
                "version_id": version_id,
                "chunk_count": len(chunks),
                "backup_manifest_path": backup["manifest_path"],
                "duration_ms": round(total_ms, 3),
            }
        )
        append_audit(audit)
        return {
            "status": "COMMITTED",
            "ingest_run_id": run_id,
            "source_id": source_id,
            "source_reused": existing["source"] is not None,
            "memory_document_id": memory_document_id,
            "asset_id": asset_id,
            "asset_reused": existing["asset"] is not None,
            "document_version_id": version_id,
            "chunk_count": len(chunks),
            "record_source_locator": {"start_line": 1, "end_line": parsed.source.line_count},
            "backup": backup,
            "backup_verification": backup_verification,
            "integrity_check": integrity,
            "foreign_key_check": foreign_keys,
            "metrics_ms": {
                "backup_and_restore_verify": round(backup_ms, 3),
                "transaction": round(transaction_ms, 3),
                "total": round(total_ms, 3),
            },
        }
    except Exception as exc:
        error = exc if isinstance(exc, IngestError) else IngestError(
            "INGEST_COMMIT_FAILED", str(exc)
        )
        audit["error_code"] = error.code
        audit["backup_manifest_path"] = None if backup is None else backup.get("manifest_path")
        audit["duration_ms"] = round((perf_counter() - started_perf) * 1000, 3)
        append_audit(audit)
        raise error from exc if error is not exc else None


def _row_with_json(row: sqlite3.Row, fields: Mapping[str, str]) -> dict[str, Any]:
    result = dict(row)
    for field, kind in fields.items():
        if kind == "object":
            result[field] = _json_object(result[field], field)
        else:
            result[field] = _json_array(result[field], field)
    return result


def get_document_asset(
    *,
    database: str | Path,
    asset_id: int | None = None,
    project_id: int | None = None,
    canonical_path: str | None = None,
) -> dict[str, Any]:
    path = resolve_database_path(database)
    _validate_database(path)
    with closing(_open_database(path, read_only=True)) as connection:
        if asset_id is not None:
            row = connection.execute("SELECT * FROM document_assets WHERE id = ?", (asset_id,)).fetchone()
        elif project_id is not None and canonical_path is not None:
            row = connection.execute(
                "SELECT * FROM document_assets WHERE project_id = ? AND canonical_path = ? COLLATE NOCASE",
                (project_id, canonical_path),
            ).fetchone()
        else:
            raise IngestError(
                "INGEST_ARGUMENT_INVALID", "asset_id or project_id plus canonical_path is required"
            )
    if row is None:
        raise IngestError("DOCUMENT_ASSET_NOT_FOUND", "document asset does not exist")
    return dict(row)


def get_document_version(*, database: str | Path, version_id: int) -> dict[str, Any]:
    path = resolve_database_path(database)
    _validate_database(path)
    with closing(_open_database(path, read_only=True)) as connection:
        row = connection.execute("SELECT * FROM document_versions WHERE id = ?", (version_id,)).fetchone()
    if row is None:
        raise IngestError("DOCUMENT_VERSION_NOT_FOUND", "document version does not exist")
    return _row_with_json(row, {"chunking_config_json": "object"})


def list_document_versions(
    *, database: str | Path, asset_id: int, limit: int = 100
) -> list[dict[str, Any]]:
    path = resolve_database_path(database)
    _validate_database(path)
    with closing(_open_database(path, read_only=True)) as connection:
        rows = connection.execute(
            "SELECT * FROM document_versions WHERE asset_id = ? ORDER BY id ASC LIMIT ?",
            (asset_id, _limit(limit, "limit")),
        ).fetchall()
    return [_row_with_json(row, {"chunking_config_json": "object"}) for row in rows]


def list_document_chunks(
    *, database: str | Path, version_id: int, limit: int = 1000
) -> list[dict[str, Any]]:
    path = resolve_database_path(database)
    _validate_database(path)
    with closing(_open_database(path, read_only=True)) as connection:
        rows = connection.execute(
            "SELECT * FROM document_chunks WHERE document_version_id = ? ORDER BY chunk_index LIMIT ?",
            (version_id, _limit(limit, "limit", 1000)),
        ).fetchall()
    return [
        _row_with_json(row, {"heading_path_json": "array", "metadata_json": "object"})
        for row in rows
    ]


def search_document_chunks(
    *,
    database: str | Path,
    query: str,
    project_id: int | None = None,
    asset_id: int | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    term = _required_text(query, "query")
    clauses = ["instr(lower(dc.content), lower(?)) > 0"]
    parameters: list[Any] = [term]
    if project_id is not None:
        clauses.append("da.project_id = ?")
        parameters.append(project_id)
    if asset_id is not None:
        clauses.append("da.id = ?")
        parameters.append(asset_id)
    parameters.append(_limit(limit, "limit", 100))
    path = resolve_database_path(database)
    _validate_database(path)
    with closing(_open_database(path, read_only=True)) as connection:
        rows = connection.execute(
            f"""
            SELECT dc.*, da.project_id, da.canonical_path, dv.asset_id
            FROM document_chunks AS dc
            JOIN document_versions AS dv ON dv.id = dc.document_version_id
            JOIN document_assets AS da ON da.id = dv.asset_id
            WHERE {' AND '.join(clauses)}
            ORDER BY dc.document_version_id, dc.chunk_index
            LIMIT ?
            """,
            parameters,
        ).fetchall()
    return [
        _row_with_json(row, {"heading_path_json": "array", "metadata_json": "object"})
        for row in rows
    ]
