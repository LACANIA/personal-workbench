"""Structured SQLite API for Research Memory."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from memory.database.init_db import (
    DEFAULT_DATABASE_PATH,
    DatabasePathError,
    initialize_database,
    resolve_database_path,
)


DatabaseArgument = str | Path | None
ENTITY_TABLES = {
    "project": "projects",
    "decision": "decisions",
    "experiment": "experiments",
    "document": "documents",
    "task": "tasks",
    "session": "sessions",
}
VERIFICATION_STATUSES = {"unverified", "verified", "disputed"}


class ResearchMemoryError(Exception):
    """Base exception for the Research Memory API."""


class MemoryValidationError(ResearchMemoryError, ValueError):
    """Raised when API input is invalid."""


class MemoryNotFoundError(ResearchMemoryError, LookupError):
    """Raised when a requested record does not exist."""


class MemoryConstraintError(ResearchMemoryError):
    """Raised when a database constraint rejects an operation."""


class MemoryStorageError(ResearchMemoryError):
    """Raised when SQLite cannot complete an operation."""


class MemoryPathError(ResearchMemoryError, ValueError):
    """Raised when a database path is outside the memory directory."""


def _database_path(database: DatabaseArgument = None) -> Path:
    try:
        return resolve_database_path(database or DEFAULT_DATABASE_PATH)
    except DatabasePathError as exc:
        raise MemoryPathError(str(exc)) from exc


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _timestamp(value: str | datetime | None) -> str:
    if value is None:
        return _utc_now()

    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise MemoryValidationError("datetime values must include timezone information")
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )

    if not isinstance(value, str) or not value.strip():
        raise MemoryValidationError("timestamp must be a non-empty ISO 8601 string")

    candidate = value.strip()
    try:
        parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MemoryValidationError(f"invalid ISO 8601 timestamp: {candidate}") from exc

    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise MemoryValidationError("timestamp must include a UTC offset or Z suffix")
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _required_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MemoryValidationError(f"{field} must be a non-empty string")
    return value.strip()


def _optional_text(value: Any, field: str) -> str | None:
    if value is None:
        return None
    return _required_text(value, field)


def _positive_id(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise MemoryValidationError(f"{field} must be a positive integer")
    return value


def _optional_positive_integer(value: Any, field: str) -> int | None:
    if value is None:
        return None
    return _positive_id(value, field)


def _limit(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 1000:
        raise MemoryValidationError("limit must be an integer from 1 to 1000")
    return value


def _encode_structured(value: Any, field: str) -> str:
    if isinstance(value, str):
        return _required_text(value, field)
    if value is None:
        raise MemoryValidationError(f"{field} must not be null")
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise MemoryValidationError(f"{field} must be text or JSON-serializable data") from exc


def _decode_structured(value: str) -> Any:
    stripped = value.strip()
    if not stripped.startswith(("{", "[")):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _record(row: sqlite3.Row, structured_fields: Sequence[str] = ()) -> dict[str, Any]:
    result = dict(row)
    for field in structured_fields:
        if field in result and isinstance(result[field], str):
            result[field] = _decode_structured(result[field])
    return result


@contextmanager
def _connection(
    database: DatabaseArgument = None, *, read_only: bool = False
) -> Iterator[sqlite3.Connection]:
    path = _database_path(database)
    if not path.exists():
        if read_only:
            raise MemoryStorageError(f"read-only database does not exist: {path}")
        try:
            initialize_database(path)
        except (OSError, RuntimeError, DatabasePathError) as exc:
            raise MemoryStorageError(f"database initialization failed: {exc}") from exc

    connection: sqlite3.Connection | None = None
    try:
        if read_only:
            database_uri = f"{path.as_uri()}?mode=ro"
            connection = sqlite3.connect(database_uri, uri=True, timeout=5.0)
        else:
            connection = sqlite3.connect(path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        if read_only:
            connection.execute("PRAGMA query_only = ON")
        yield connection
        if not read_only:
            connection.commit()
    except sqlite3.IntegrityError as exc:
        if connection is not None:
            connection.rollback()
        raise MemoryConstraintError(str(exc)) from exc
    except sqlite3.Error as exc:
        if connection is not None:
            connection.rollback()
        raise MemoryStorageError(str(exc)) from exc
    finally:
        if connection is not None:
            connection.close()


def create_project(
    name: str,
    description: str,
    root_path: str,
    status: str = "active",
    *,
    database: DatabaseArgument = None,
    created_at: str | datetime | None = None,
    updated_at: str | datetime | None = None,
) -> dict[str, Any]:
    """Create and return one Project record."""
    created = _timestamp(created_at)
    updated = _timestamp(updated_at) if updated_at is not None else created
    values = (
        _required_text(name, "name"),
        _required_text(description, "description"),
        _required_text(root_path, "root_path"),
        _required_text(status, "status"),
        created,
        updated,
    )
    with _connection(database) as connection:
        cursor = connection.execute(
            """
            INSERT INTO projects(name, description, root_path, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        row = connection.execute("SELECT * FROM projects WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _record(row)


def get_project(
    *,
    project_id: int | None = None,
    name: str | None = None,
    database: DatabaseArgument = None,
    read_only: bool = False,
) -> dict[str, Any]:
    """Get one Project by id or name."""
    if (project_id is None) == (name is None):
        raise MemoryValidationError("provide exactly one of project_id or name")
    if project_id is not None:
        clause, value = "id = ?", _positive_id(project_id, "project_id")
    else:
        clause, value = "name = ?", _required_text(name, "name")
    with _connection(database, read_only=read_only) as connection:
        row = connection.execute(f"SELECT * FROM projects WHERE {clause}", (value,)).fetchone()
    if row is None:
        raise MemoryNotFoundError(f"project not found: {value}")
    return _record(row)


def list_projects(
    *,
    status: str | None = None,
    limit: int = 100,
    database: DatabaseArgument = None,
    read_only: bool = False,
) -> list[dict[str, Any]]:
    """List Project records, optionally filtered by status."""
    parameters: list[Any] = []
    sql = "SELECT * FROM projects"
    if status is not None:
        sql += " WHERE status = ?"
        parameters.append(_required_text(status, "status"))
    sql += " ORDER BY updated_at DESC, id ASC LIMIT ?"
    parameters.append(_limit(limit))
    with _connection(database, read_only=read_only) as connection:
        rows = connection.execute(sql, parameters).fetchall()
    return [_record(row) for row in rows]


def add_decision(
    project_id: int,
    title: str,
    reason: str,
    evidence: str | Mapping[str, Any] | Sequence[Any],
    confidence: str,
    *,
    database: DatabaseArgument = None,
    created_at: str | datetime | None = None,
) -> dict[str, Any]:
    """Create and return one Decision record."""
    values = (
        _positive_id(project_id, "project_id"),
        _required_text(title, "title"),
        _required_text(reason, "reason"),
        _encode_structured(evidence, "evidence"),
        _required_text(confidence, "confidence"),
        _timestamp(created_at),
    )
    with _connection(database) as connection:
        cursor = connection.execute(
            """
            INSERT INTO decisions(project_id, title, reason, evidence, confidence, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        row = connection.execute("SELECT * FROM decisions WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _record(row, ("evidence",))


def query_decisions(
    project_id: int,
    *,
    confidence: str | None = None,
    limit: int = 100,
    database: DatabaseArgument = None,
    read_only: bool = False,
) -> list[dict[str, Any]]:
    """Query Decision records for one project."""
    parameters: list[Any] = [_positive_id(project_id, "project_id")]
    sql = "SELECT * FROM decisions WHERE project_id = ?"
    if confidence is not None:
        sql += " AND confidence = ?"
        parameters.append(_required_text(confidence, "confidence"))
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    parameters.append(_limit(limit))
    with _connection(database, read_only=read_only) as connection:
        rows = connection.execute(sql, parameters).fetchall()
    return [_record(row, ("evidence",)) for row in rows]


def add_experiment(
    project_id: int,
    name: str,
    config: str | Mapping[str, Any] | Sequence[Any],
    result: str | Mapping[str, Any] | Sequence[Any],
    metric: str,
    artifact_path: str | None = None,
    *,
    database: DatabaseArgument = None,
    created_at: str | datetime | None = None,
) -> dict[str, Any]:
    """Create and return one Experiment record."""
    artifact = None if artifact_path is None else _required_text(artifact_path, "artifact_path")
    values = (
        _positive_id(project_id, "project_id"),
        _required_text(name, "name"),
        _encode_structured(config, "config"),
        _encode_structured(result, "result"),
        _required_text(metric, "metric"),
        artifact,
        _timestamp(created_at),
    )
    with _connection(database) as connection:
        cursor = connection.execute(
            """
            INSERT INTO experiments(project_id, name, config, result, metric, artifact_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        row = connection.execute("SELECT * FROM experiments WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _record(row, ("config", "result"))


def query_experiments(
    project_id: int,
    *,
    name: str | None = None,
    limit: int = 100,
    database: DatabaseArgument = None,
    read_only: bool = False,
) -> list[dict[str, Any]]:
    """Query Experiment records for one project."""
    parameters: list[Any] = [_positive_id(project_id, "project_id")]
    sql = "SELECT * FROM experiments WHERE project_id = ?"
    if name is not None:
        sql += " AND name = ?"
        parameters.append(_required_text(name, "name"))
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    parameters.append(_limit(limit))
    with _connection(database, read_only=read_only) as connection:
        rows = connection.execute(sql, parameters).fetchall()
    return [_record(row, ("config", "result")) for row in rows]


def add_document(
    project_id: int,
    path: str,
    type: str,
    summary: str,
    hash: str,
    *,
    database: DatabaseArgument = None,
    created_at: str | datetime | None = None,
) -> dict[str, Any]:
    """Create and return one Document metadata record without reading the file."""
    values = (
        _positive_id(project_id, "project_id"),
        _required_text(path, "path"),
        _required_text(type, "type"),
        _required_text(summary, "summary"),
        _required_text(hash, "hash"),
        _timestamp(created_at),
    )
    with _connection(database) as connection:
        cursor = connection.execute(
            """
            INSERT INTO documents(project_id, path, type, summary, hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        row = connection.execute("SELECT * FROM documents WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _record(row)


def query_documents(
    project_id: int,
    *,
    document_type: str | None = None,
    path: str | None = None,
    limit: int = 100,
    database: DatabaseArgument = None,
    read_only: bool = False,
) -> list[dict[str, Any]]:
    """Query Document metadata for one project."""
    parameters: list[Any] = [_positive_id(project_id, "project_id")]
    sql = "SELECT * FROM documents WHERE project_id = ?"
    if document_type is not None:
        sql += " AND type = ?"
        parameters.append(_required_text(document_type, "document_type"))
    if path is not None:
        sql += " AND path = ?"
        parameters.append(_required_text(path, "path"))
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    parameters.append(_limit(limit))
    with _connection(database, read_only=read_only) as connection:
        rows = connection.execute(sql, parameters).fetchall()
    return [_record(row) for row in rows]


def create_task(
    project_id: int,
    description: str,
    status: str = "pending",
    *,
    database: DatabaseArgument = None,
    created_at: str | datetime | None = None,
) -> dict[str, Any]:
    """Create and return one Task record."""
    values = (
        _positive_id(project_id, "project_id"),
        _required_text(description, "description"),
        _required_text(status, "status"),
        _timestamp(created_at),
    )
    with _connection(database) as connection:
        cursor = connection.execute(
            """
            INSERT INTO tasks(project_id, description, status, created_at)
            VALUES (?, ?, ?, ?)
            """,
            values,
        )
        row = connection.execute("SELECT * FROM tasks WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _record(row)


def update_task(
    task_id: int,
    *,
    status: str | None = None,
    description: str | None = None,
    database: DatabaseArgument = None,
) -> dict[str, Any]:
    """Update selected fields on one Task record and return it."""
    task_key = _positive_id(task_id, "task_id")
    updates: list[str] = []
    values: list[Any] = []
    if description is not None:
        updates.append("description = ?")
        values.append(_required_text(description, "description"))
    if status is not None:
        updates.append("status = ?")
        values.append(_required_text(status, "status"))
    if not updates:
        raise MemoryValidationError("provide status or description to update")
    values.append(task_key)
    with _connection(database) as connection:
        cursor = connection.execute(
            f"UPDATE tasks SET {', '.join(updates)} WHERE id = ?", values
        )
        if cursor.rowcount == 0:
            raise MemoryNotFoundError(f"task not found: {task_key}")
        row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_key,)).fetchone()
    return _record(row)


def query_tasks(
    project_id: int,
    *,
    status: str | None = None,
    limit: int = 100,
    database: DatabaseArgument = None,
    read_only: bool = False,
) -> list[dict[str, Any]]:
    """Query Task records for one project."""
    parameters: list[Any] = [_positive_id(project_id, "project_id")]
    sql = "SELECT * FROM tasks WHERE project_id = ?"
    if status is not None:
        sql += " AND status = ?"
        parameters.append(_required_text(status, "status"))
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    parameters.append(_limit(limit))
    with _connection(database, read_only=read_only) as connection:
        rows = connection.execute(sql, parameters).fetchall()
    return [_record(row) for row in rows]


def add_session(
    task_id: int,
    model: str,
    tools: str | Mapping[str, Any] | Sequence[Any],
    result: str | Mapping[str, Any] | Sequence[Any],
    *,
    database: DatabaseArgument = None,
    created_at: str | datetime | None = None,
) -> dict[str, Any]:
    """Create and return one Session record."""
    values = (
        _positive_id(task_id, "task_id"),
        _required_text(model, "model"),
        _encode_structured(tools, "tools"),
        _encode_structured(result, "result"),
        _timestamp(created_at),
    )
    with _connection(database) as connection:
        cursor = connection.execute(
            """
            INSERT INTO sessions(task_id, model, tools, result, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            values,
        )
        row = connection.execute("SELECT * FROM sessions WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _record(row, ("tools", "result"))


def query_sessions(
    *,
    task_id: int | None = None,
    project_id: int | None = None,
    model: str | None = None,
    limit: int = 100,
    database: DatabaseArgument = None,
    read_only: bool = False,
) -> list[dict[str, Any]]:
    """Query Session records by task, project, model, or any combination."""
    clauses: list[str] = []
    parameters: list[Any] = []
    sql = "SELECT sessions.* FROM sessions"
    if project_id is not None:
        sql += " JOIN tasks ON tasks.id = sessions.task_id"
        clauses.append("tasks.project_id = ?")
        parameters.append(_positive_id(project_id, "project_id"))
    if task_id is not None:
        clauses.append("sessions.task_id = ?")
        parameters.append(_positive_id(task_id, "task_id"))
    if model is not None:
        clauses.append("sessions.model = ?")
        parameters.append(_required_text(model, "model"))
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY sessions.created_at DESC, sessions.id DESC LIMIT ?"
    parameters.append(_limit(limit))
    with _connection(database, read_only=read_only) as connection:
        rows = connection.execute(sql, parameters).fetchall()
    return [_record(row, ("tools", "result")) for row in rows]


def _entity_table(entity_type: str) -> tuple[str, str]:
    normalized = _required_text(entity_type, "entity_type").casefold()
    table = ENTITY_TABLES.get(normalized)
    if table is None:
        raise MemoryValidationError(
            "entity_type must be project, decision, experiment, document, task, or session"
        )
    return normalized, table


def _assert_record_exists(
    connection: sqlite3.Connection, entity_type: str, entity_id: int
) -> tuple[str, int]:
    normalized, table = _entity_table(entity_type)
    record_id = _positive_id(entity_id, "entity_id")
    if connection.execute(f"SELECT 1 FROM {table} WHERE id = ?", (record_id,)).fetchone() is None:
        raise MemoryNotFoundError(f"{normalized} record not found: {record_id}")
    return normalized, record_id


def add_source(
    source_type: str,
    *,
    project_id: int | None = None,
    canonical_path: str | None = None,
    external_ref: str | None = None,
    content_hash: str | None = None,
    source_version: str | None = None,
    database: DatabaseArgument = None,
    created_at: str | datetime | None = None,
    verified_at: str | datetime | None = None,
) -> dict[str, Any]:
    """Create one source metadata record without reading source content."""
    project_key = _optional_positive_integer(project_id, "project_id")
    path_value = _optional_text(canonical_path, "canonical_path")
    ref_value = _optional_text(external_ref, "external_ref")
    if path_value is None and ref_value is None:
        raise MemoryValidationError("canonical_path or external_ref is required")
    if path_value is not None:
        path_value = str(Path(path_value).expanduser().resolve(strict=False))
    values = (
        project_key,
        _required_text(source_type, "source_type"),
        path_value,
        ref_value,
        _optional_text(content_hash, "content_hash"),
        _optional_text(source_version, "source_version"),
        _timestamp(created_at),
        None if verified_at is None else _timestamp(verified_at),
    )
    with _connection(database) as connection:
        if project_key is not None and connection.execute(
            "SELECT 1 FROM projects WHERE id = ?", (project_key,)
        ).fetchone() is None:
            raise MemoryNotFoundError(f"project not found: {project_key}")
        cursor = connection.execute(
            """
            INSERT INTO sources(
                project_id, source_type, canonical_path, external_ref, content_hash,
                source_version, created_at, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        row = connection.execute("SELECT * FROM sources WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _record(row)


def get_source(
    source_id: int,
    *,
    database: DatabaseArgument = None,
    read_only: bool = False,
) -> dict[str, Any]:
    """Return one source metadata record."""
    source_key = _positive_id(source_id, "source_id")
    with _connection(database, read_only=read_only) as connection:
        row = connection.execute("SELECT * FROM sources WHERE id = ?", (source_key,)).fetchone()
    if row is None:
        raise MemoryNotFoundError(f"source not found: {source_key}")
    return _record(row)


def query_sources(
    *,
    project_id: int | None = None,
    source_type: str | None = None,
    canonical_path: str | None = None,
    external_ref: str | None = None,
    content_hash: str | None = None,
    limit: int = 100,
    database: DatabaseArgument = None,
    read_only: bool = False,
) -> list[dict[str, Any]]:
    """Query source metadata using explicit filters."""
    clauses: list[str] = []
    parameters: list[Any] = []
    filters = (
        ("project_id", _optional_positive_integer(project_id, "project_id")),
        ("source_type", _optional_text(source_type, "source_type")),
        ("canonical_path", _optional_text(canonical_path, "canonical_path")),
        ("external_ref", _optional_text(external_ref, "external_ref")),
        ("content_hash", _optional_text(content_hash, "content_hash")),
    )
    for column, value in filters:
        if value is not None:
            clauses.append(f"{column} = ?")
            parameters.append(value)
    sql = "SELECT * FROM sources"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    parameters.append(_limit(limit))
    with _connection(database, read_only=read_only) as connection:
        rows = connection.execute(sql, parameters).fetchall()
    return [_record(row) for row in rows]


def link_record_source(
    entity_type: str,
    entity_id: int,
    source_id: int,
    *,
    role: str,
    locator_type: str,
    locator_start: int | None = None,
    locator_end: int | None = None,
    locator_json: str | Mapping[str, Any] | Sequence[Any] | None = None,
    note: str | None = None,
    verification_status: str = "unverified",
    database: DatabaseArgument = None,
    created_at: str | datetime | None = None,
    verified_at: str | datetime | None = None,
) -> dict[str, Any]:
    """Link an existing business record to an existing source."""
    source_key = _positive_id(source_id, "source_id")
    start = _optional_positive_integer(locator_start, "locator_start")
    end = _optional_positive_integer(locator_end, "locator_end")
    if start is not None and end is not None and end < start:
        raise MemoryValidationError("locator_end must be greater than or equal to locator_start")
    status = _required_text(verification_status, "verification_status").casefold()
    if status not in VERIFICATION_STATUSES:
        raise MemoryValidationError("verification_status must be unverified, verified, or disputed")
    locator_payload = None if locator_json is None else _encode_structured(locator_json, "locator_json")

    with _connection(database) as connection:
        normalized, record_id = _assert_record_exists(connection, entity_type, entity_id)
        if connection.execute("SELECT 1 FROM sources WHERE id = ?", (source_key,)).fetchone() is None:
            raise MemoryNotFoundError(f"source not found: {source_key}")
        duplicate = connection.execute(
            """
            SELECT id FROM record_sources
            WHERE entity_type = ? AND entity_id = ? AND source_id = ? AND role = ?
              AND locator_type = ? AND COALESCE(locator_start, -1) = COALESCE(?, -1)
              AND COALESCE(locator_end, -1) = COALESCE(?, -1)
            """,
            (
                normalized,
                record_id,
                source_key,
                _required_text(role, "role"),
                _required_text(locator_type, "locator_type"),
                start,
                end,
            ),
        ).fetchone()
        if duplicate is not None:
            raise MemoryConstraintError(f"record-source link already exists: {duplicate['id']}")
        cursor = connection.execute(
            """
            INSERT INTO record_sources(
                entity_type, entity_id, source_id, role, locator_type,
                locator_start, locator_end, locator_json, note,
                verification_status, created_at, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                normalized,
                record_id,
                source_key,
                _required_text(role, "role"),
                _required_text(locator_type, "locator_type"),
                start,
                end,
                locator_payload,
                _optional_text(note, "note"),
                status,
                _timestamp(created_at),
                None if verified_at is None else _timestamp(verified_at),
            ),
        )
        row = connection.execute(
            "SELECT * FROM record_sources WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
    return _record(row, ("locator_json",))


def get_record_sources(
    entity_type: str,
    entity_id: int,
    *,
    limit: int = 100,
    database: DatabaseArgument = None,
    read_only: bool = False,
) -> list[dict[str, Any]]:
    """Return source links and source metadata for one existing record."""
    with _connection(database, read_only=read_only) as connection:
        normalized, record_id = _assert_record_exists(connection, entity_type, entity_id)
        rows = connection.execute(
            """
            SELECT
                rs.id AS link_id, rs.entity_type, rs.entity_id, rs.source_id,
                rs.role, rs.locator_type, rs.locator_start, rs.locator_end,
                rs.locator_json, rs.note, rs.verification_status,
                rs.created_at AS link_created_at, rs.verified_at AS link_verified_at,
                s.project_id AS source_project_id, s.source_type,
                s.canonical_path, s.external_ref, s.content_hash, s.source_version,
                s.created_at AS source_created_at, s.verified_at AS source_verified_at
            FROM record_sources AS rs
            JOIN sources AS s ON s.id = rs.source_id
            WHERE rs.entity_type = ? AND rs.entity_id = ?
            ORDER BY rs.id ASC
            LIMIT ?
            """,
            (normalized, record_id, _limit(limit)),
        ).fetchall()
    results = []
    for row in rows:
        item = _record(row, ("locator_json",))
        source = {
            "id": item.pop("source_id"),
            "project_id": item.pop("source_project_id"),
            "source_type": item.pop("source_type"),
            "canonical_path": item.pop("canonical_path"),
            "external_ref": item.pop("external_ref"),
            "content_hash": item.pop("content_hash"),
            "source_version": item.pop("source_version"),
            "created_at": item.pop("source_created_at"),
            "verified_at": item.pop("source_verified_at"),
        }
        item["source_id"] = source["id"]
        item["source"] = source
        results.append(item)
    return results
