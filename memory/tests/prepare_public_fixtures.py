"""Create synthetic SQLite fixtures used by public CI without shipping database files."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path

from memory.database.init_db import initialize_database
from memory.search.fts_rebuild import rebuild_fts_index


MEMORY_ROOT = Path(__file__).resolve().parents[1]
PRODUCTION_DATABASE = MEMORY_ROOT / "database" / "research_memory.db"
TEST_DATABASE = MEMORY_ROOT / "tests" / "test_research_memory.db"
SOURCE_FILE = MEMORY_ROOT / "tests" / "fixtures" / "research-memory-public-source.md"
STAMP = "2026-01-01T00:00:00.000Z"


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def prepare() -> None:
    initialize_database(PRODUCTION_DATABASE)
    rebuild_fts_index(PRODUCTION_DATABASE, create_backup=False)
    initialize_database(TEST_DATABASE)
    with closing(sqlite3.connect(TEST_DATABASE)) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        if connection.execute("SELECT COUNT(*) FROM projects").fetchone()[0] != 0:
            return

        project_id = connection.execute(
            "INSERT INTO projects(name, description, root_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            ("STAKG-SP", "Synthetic public CI fixture", "C:/workspace/STAKG-SP", "active", STAMP, STAMP),
        ).lastrowid
        decision_id = connection.execute(
            "INSERT INTO decisions(project_id, title, reason, evidence, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (project_id, "停止GNN直接定位优化", "Synthetic decision", json.dumps(["0.0136%"]), "high", STAMP),
        ).lastrowid
        experiment_id = connection.execute(
            "INSERT INTO experiments(project_id, name, config, result, metric, artifact_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (project_id, "GNN localization comparison", json.dumps({"fixture": True}), json.dumps({"status": "complete"}), "0.0136%", None, STAMP),
        ).lastrowid
        parent_document_id = connection.execute(
            "INSERT INTO documents(project_id, path, type, summary, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (project_id, "Parent_Project_v0.5.5.pdf", "pdf", "Synthetic parent document", _hash("parent"), "2026-02-01T00:00:00.000Z"),
        ).lastrowid
        chunk_document_id = connection.execute(
            "INSERT INTO documents(project_id, path, type, summary, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (project_id, "research-memory-public-source.md", "markdown_report", "Synthetic search document", _hash("chunks"), STAMP),
        ).lastrowid
        source_id = connection.execute(
            "INSERT INTO sources(project_id, source_type, canonical_path, content_hash, source_version, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (project_id, "report", str(SOURCE_FILE.resolve()), _hash(SOURCE_FILE.read_text(encoding="utf-8")), "STEP-10", STAMP, STAMP),
        ).lastrowid
        for entity_type, entity_id, start in (
            ("decision", decision_id, 183),
            ("experiment", experiment_id, 185),
            ("document", parent_document_id, 186),
        ):
            connection.execute(
                "INSERT INTO record_sources(entity_type, entity_id, source_id, role, locator_type, locator_start, locator_end, verification_status, created_at, verified_at) VALUES (?, ?, ?, 'supports', 'line', ?, ?, 'verified', ?, ?)",
                (entity_type, entity_id, source_id, start, start, STAMP, STAMP),
            )

        asset_id = connection.execute(
            "INSERT INTO document_assets(project_id, canonical_path, document_type, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (project_id, str(SOURCE_FILE.resolve()), "markdown_report", "Research Memory public fixture", STAMP, STAMP),
        ).lastrowid
        chunk_contents = [
            "GNN localization comparison metric 0.0136%.",
            "Synthetic public fixture for bounded document search.",
            "No personal or production data is included.",
        ]
        normalized_text = "\n".join(chunk_contents)
        normalized_hash = _hash(normalized_text)
        version_id = connection.execute(
            """INSERT INTO document_versions(
                asset_id, memory_document_id, source_id, content_hash, normalized_text_hash,
                source_version, parser_name, parser_version, chunker_name, chunker_version,
                chunking_config_json, text_encoding, byte_count, line_count, chunk_count, created_at
            ) VALUES (?, ?, ?, ?, ?, 'STEP-10', 'public-fixture', '1', 'public-fixture', '1', '{}', 'utf-8', ?, ?, ?, ?)""",
            (asset_id, chunk_document_id, source_id, normalized_hash, normalized_hash, len(normalized_text.encode("utf-8")), len(chunk_contents), len(chunk_contents), STAMP),
        ).lastrowid
        for index, content in enumerate(chunk_contents):
            content_hash = _hash(content)
            uid = _hash(f"{normalized_hash}:{index}:{content_hash}")
            connection.execute(
                "INSERT INTO document_chunks(document_version_id, chunk_uid, chunk_index, heading_path_json, start_line, end_line, content_hash, content, char_count, metadata_json, created_at) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, '{}', ?)",
                (version_id, uid, index, index + 1, index + 1, content_hash, content, len(content), STAMP),
            )
        connection.commit()
    rebuild_fts_index(TEST_DATABASE, create_backup=False)


if __name__ == "__main__":
    prepare()
    print("Prepared synthetic Research Memory fixtures.")
