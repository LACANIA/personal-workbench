"""Register STEP-12 provenance metadata in the canonical test database only."""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


MY_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(MY_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(MY_AGENT_ROOT))

from memory.api.memory_api import (  # noqa: E402
    MemoryConstraintError,
    MemoryNotFoundError,
    add_source,
    get_project,
    get_record_sources,
    link_record_source,
    query_decisions,
    query_documents,
    query_experiments,
    query_sources,
)


TEST_DATABASE = MY_AGENT_ROOT / "memory" / "tests" / "test_research_memory.db"
PRODUCTION_DATABASE = MY_AGENT_ROOT / "memory" / "database" / "research_memory.db"
SOURCE_REPORT = MY_AGENT_ROOT.parent / "reports" / "RESEARCH_MEMORY_FOUNDATION_REPORT_STEP_10.md"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _single(records: list[dict], field: str, value: str) -> dict:
    selected = [record for record in records if record.get(field) == value]
    if len(selected) != 1:
        raise MemoryNotFoundError(f"expected one {field}={value!r}; found {len(selected)}")
    return selected[0]


def seed() -> dict:
    """Create one Source and three verified source links in the test database."""
    if TEST_DATABASE.resolve() == PRODUCTION_DATABASE.resolve():
        raise RuntimeError("test and production database paths must differ")
    if not SOURCE_REPORT.is_file():
        raise FileNotFoundError(SOURCE_REPORT)

    project = get_project(name="STAKG-SP", database=TEST_DATABASE)
    decision = _single(
        query_decisions(project["id"], database=TEST_DATABASE),
        "title",
        "停止GNN直接定位优化",
    )
    experiment = _single(
        query_experiments(project["id"], database=TEST_DATABASE),
        "name",
        "GNN localization comparison",
    )
    document = _single(
        query_documents(project["id"], database=TEST_DATABASE),
        "path",
        "Parent_Project_v0.5.5.pdf",
    )

    report_path = str(SOURCE_REPORT.resolve(strict=True))
    report_hash = _sha256(SOURCE_REPORT)
    existing = query_sources(
        project_id=project["id"],
        source_type="report",
        canonical_path=report_path,
        content_hash=report_hash,
        database=TEST_DATABASE,
    )
    if existing:
        source = existing[0]
    else:
        now = _utc_now()
        source = add_source(
            "report",
            project_id=project["id"],
            canonical_path=report_path,
            content_hash=report_hash,
            source_version="STEP-10",
            verified_at=now,
            database=TEST_DATABASE,
        )

    requested_links = [
        ("decision", decision["id"], 183, 184),
        ("experiment", experiment["id"], 185, 185),
        ("document", document["id"], 186, 186),
    ]
    links = []
    for entity_type, entity_id, start, end in requested_links:
        try:
            link = link_record_source(
                entity_type,
                entity_id,
                source["id"],
                role="supports",
                locator_type="line",
                locator_start=start,
                locator_end=end,
                verification_status="verified",
                verified_at=source["verified_at"],
                database=TEST_DATABASE,
            )
        except MemoryConstraintError:
            candidates = get_record_sources(entity_type, entity_id, database=TEST_DATABASE)
            matching = [
                item
                for item in candidates
                if item["source"]["id"] == source["id"]
                and item["role"] == "supports"
                and item["locator_type"] == "line"
                and item["locator_start"] == start
                and item["locator_end"] == end
            ]
            if len(matching) != 1:
                raise
            link = matching[0]
        links.append(link)

    return {
        "database": str(TEST_DATABASE),
        "production_database_untouched": str(PRODUCTION_DATABASE),
        "source": source,
        "links": links,
    }


if __name__ == "__main__":
    print(json.dumps(seed(), ensure_ascii=False, indent=2))
