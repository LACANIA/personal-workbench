"""Research Agent interface with bounded structured queries and source metadata."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping, Sequence

from memory.api.memory_api import (
    DatabaseArgument,
    MemoryValidationError,
    _connection,
    _record,
    add_decision,
    add_document,
    add_experiment,
    add_session,
    create_project,
    create_task,
    get_project,
    get_record_sources,
)


ENTITY_TYPES = ("project", "decision", "experiment", "document", "task", "session")
STRUCTURED_FIELDS = {
    "project": (),
    "decision": ("evidence",),
    "experiment": ("config", "result"),
    "document": (),
    "task": (),
    "session": ("tools", "result"),
}
SEARCH_SPECS = {
    "project": {
        "from": "projects AS item",
        "project_clause": "item.id = ?",
        "fields": ("name", "description", "root_path", "status"),
    },
    "decision": {
        "from": "decisions AS item",
        "project_clause": "item.project_id = ?",
        "fields": ("title", "reason", "evidence", "confidence"),
    },
    "experiment": {
        "from": "experiments AS item",
        "project_clause": "item.project_id = ?",
        "fields": ("name", "config", "result", "metric", "artifact_path"),
    },
    "document": {
        "from": "documents AS item",
        "project_clause": "item.project_id = ?",
        "fields": ("path", "type", "summary", "hash"),
    },
    "task": {
        "from": "tasks AS item",
        "project_clause": "item.project_id = ?",
        "fields": ("description", "status"),
    },
    "session": {
        "from": "sessions AS item JOIN tasks AS owner_task ON owner_task.id = item.task_id",
        "project_clause": "owner_task.project_id = ?",
        "fields": ("model", "tools", "result"),
    },
}


def _bounded_limit(value: int, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100:
        raise MemoryValidationError(f"{field} must be an integer from 1 to 100")
    return value


def _entity_selection(entity_types: Sequence[str] | None) -> list[str]:
    if entity_types is None:
        return list(ENTITY_TYPES)
    if isinstance(entity_types, (str, bytes)) or not isinstance(entity_types, Sequence):
        raise MemoryValidationError("entity_types must be an array of entity type strings")
    selected: list[str] = []
    for value in entity_types:
        if not isinstance(value, str) or value.strip().casefold() not in ENTITY_TYPES:
            raise MemoryValidationError(
                "entity_types may contain only project, decision, experiment, document, task, or session"
            )
        normalized = value.strip().casefold()
        if normalized not in selected:
            selected.append(normalized)
    if not selected:
        raise MemoryValidationError("entity_types must contain at least one entity type")
    return selected


def _with_sources(
    record: dict[str, Any],
    entity_type: str,
    *,
    database: DatabaseArgument,
    read_only: bool,
) -> dict[str, Any]:
    enriched = dict(record)
    enriched["memory_citation"] = f"[Memory:{entity_type}#{record['id']}]"
    enriched["sources"] = get_record_sources(
        entity_type,
        record["id"],
        database=database,
        read_only=read_only,
    )
    enriched["source_status"] = "registered" if enriched["sources"] else "not_registered"
    source_citations = []
    for link in enriched["sources"]:
        source = link["source"]
        reference = source["canonical_path"] or source["external_ref"]
        if link["locator_start"] is None:
            locator = ""
        elif link["locator_end"] is None:
            locator = f":{link['locator_start']}"
        else:
            locator = f":{link['locator_start']}-{link['locator_end']}"
        source_citations.append(f"[Source:{link['source_id']} {reference}{locator}]")
    enriched["source_citations"] = source_citations
    return enriched


def _query_entity(
    entity_type: str,
    term: str,
    project_id: int | None,
    limit: int,
    *,
    database: DatabaseArgument,
    read_only: bool,
) -> tuple[list[dict[str, Any]], int, bool]:
    spec = SEARCH_SPECS[entity_type]
    searchable = " || ' ' || ".join(
        f"COALESCE(CAST(item.{field} AS TEXT), '')" for field in spec["fields"]
    )
    clauses = [f"instr(lower({searchable}), lower(?)) > 0"]
    parameters: list[Any] = [term]
    if project_id is not None:
        clauses.append(spec["project_clause"])
        parameters.append(project_id)
    where = " AND ".join(clauses)
    with _connection(database, read_only=read_only) as connection:
        count = connection.execute(
            f"SELECT COUNT(*) FROM {spec['from']} WHERE {where}", parameters
        ).fetchone()[0]
        rows = connection.execute(
            f"SELECT item.* FROM {spec['from']} WHERE {where} ORDER BY item.id ASC LIMIT ?",
            [*parameters, limit],
        ).fetchall()
    return [_record(row, STRUCTURED_FIELDS[entity_type]) for row in rows], count, count > limit


def get_project_context(
    project_name: str,
    *,
    database: DatabaseArgument = None,
    read_only: bool = False,
    include_sources: bool = False,
    limit_per_entity: int = 20,
) -> dict[str, Any]:
    """Return one project and bounded related records, optionally with sources."""
    limit = _bounded_limit(limit_per_entity, "limit_per_entity")
    project = get_project(name=project_name, database=database, read_only=read_only)
    project_id = project["id"]
    table_specs = {
        "decisions": ("decision", "decisions", "project_id = ?", (project_id,)),
        "experiments": ("experiment", "experiments", "project_id = ?", (project_id,)),
        "documents": ("document", "documents", "project_id = ?", (project_id,)),
        "tasks": ("task", "tasks", "project_id = ?", (project_id,)),
        "sessions": (
            "session",
            "sessions JOIN tasks ON tasks.id = sessions.task_id",
            "tasks.project_id = ?",
            (project_id,),
        ),
    }
    output: dict[str, Any] = {
        "project": project,
        "applied_filters": {
            "project_name": project["name"],
            "include_sources": bool(include_sources),
            "limit_per_entity": limit,
        },
    }
    counts: dict[str, int] = {"projects": 1}
    returned_counts: dict[str, int] = {"projects": 1}
    truncated_by_type: dict[str, bool] = {"projects": False}
    if include_sources:
        output["project"] = _with_sources(
            project, "project", database=database, read_only=read_only
        )

    with _connection(database, read_only=read_only) as connection:
        for plural, (entity_type, from_clause, where_clause, parameters) in table_specs.items():
            count = connection.execute(
                f"SELECT COUNT(*) FROM {from_clause} WHERE {where_clause}", parameters
            ).fetchone()[0]
            prefix = "sessions" if entity_type == "session" else plural
            rows = connection.execute(
                f"SELECT {prefix}.* FROM {from_clause} WHERE {where_clause} "
                f"ORDER BY {prefix}.id ASC LIMIT ?",
                (*parameters, limit),
            ).fetchall()
            records = [_record(row, STRUCTURED_FIELDS[entity_type]) for row in rows]
            output[plural] = records
            counts[plural] = count
            returned_counts[plural] = len(records)
            truncated_by_type[plural] = count > limit

    if include_sources:
        for plural, (entity_type, *_rest) in table_specs.items():
            output[plural] = [
                _with_sources(record, entity_type, database=database, read_only=read_only)
                for record in output[plural]
            ]
    output["counts"] = counts
    output["returned_counts"] = returned_counts
    output["truncated_by_type"] = truncated_by_type
    output["truncated"] = any(truncated_by_type.values())
    return output


def query_memory(
    query: str,
    *,
    database: DatabaseArgument = None,
    read_only: bool = False,
    entity_types: Sequence[str] | None = None,
    project_name: str | None = None,
    limit_per_type: int = 20,
    include_sources: bool = False,
) -> dict[str, Any]:
    """Search selected entity types with project scope and per-type result limits."""
    if not isinstance(query, str) or not query.strip():
        raise MemoryValidationError("query must be a non-empty string")
    term = query.strip()
    selected = _entity_selection(entity_types)
    limit = _bounded_limit(limit_per_type, "limit_per_type")
    project = None
    if project_name is not None:
        if not isinstance(project_name, str) or not project_name.strip():
            raise MemoryValidationError("project_name must be a non-empty string")
        project = get_project(name=project_name.strip(), database=database, read_only=read_only)

    records: dict[str, list[dict[str, Any]]] = {}
    counts: dict[str, int] = {}
    returned_counts: dict[str, int] = {}
    truncated_by_type: dict[str, bool] = {}
    for entity_type in selected:
        plural = f"{entity_type}s"
        found, count, truncated = _query_entity(
            entity_type,
            term,
            None if project is None else project["id"],
            limit,
            database=database,
            read_only=read_only,
        )
        if include_sources:
            found = [
                _with_sources(item, entity_type, database=database, read_only=read_only)
                for item in found
            ]
        records[plural] = found
        counts[plural] = count
        returned_counts[plural] = len(found)
        truncated_by_type[plural] = truncated

    return {
        "query": term,
        "applied_filters": {
            "entity_types": selected,
            "project_name": None if project is None else project["name"],
            "limit_per_type": limit,
            "include_sources": bool(include_sources),
        },
        "truncated": any(truncated_by_type.values()),
        "truncated_by_type": truncated_by_type,
        "counts": counts,
        "returned_counts": returned_counts,
        "match_count": sum(returned_counts.values()),
        "records": records,
    }


def add_memory(
    type: str,
    data: Mapping[str, Any],
    *,
    database: str | Path | None = None,
) -> dict[str, Any]:
    """Dispatch one structured record to the corresponding offline write API."""
    if not isinstance(type, str) or not type.strip():
        raise MemoryValidationError("type must be a non-empty string")
    if not isinstance(data, Mapping):
        raise MemoryValidationError("data must be a mapping")

    entity_type = type.strip().casefold()
    handlers = {
        "project": create_project,
        "decision": add_decision,
        "experiment": add_experiment,
        "document": add_document,
        "task": create_task,
        "session": add_session,
    }
    handler = handlers.get(entity_type)
    if handler is None:
        raise MemoryValidationError(
            "unsupported memory type; expected project, decision, experiment, document, task, or session"
        )
    try:
        record = handler(**dict(data), database=database)
    except TypeError as exc:
        raise MemoryValidationError(f"invalid data for {entity_type}: {exc}") from exc
    return {"memory_type": entity_type, "record": record}
