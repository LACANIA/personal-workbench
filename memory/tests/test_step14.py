"""STEP-14 FTS5 migration, maintenance, query, and safety tests."""

from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from memory.api.memory_api import MemoryNotFoundError, MemoryStorageError, MemoryValidationError
from memory.database.backup_db import backup_database
from memory.database.init_db import MEMORY_ROOT, initialize_database
from memory.database.migrate_db import MigrationError, migrate_database
from memory.database.validate_db import inspect_database
from memory.search.chunk_query import get_document_chunk, search_document_chunks
from memory.search.fts_rebuild import rebuild_fts_index
from memory.search.fts_state import computed_state, state_row
from memory.search.fts_validate import validate_database_fts
from memory.search.query_parser import parse_search_query


RUNTIME = MEMORY_ROOT / "tests" / "runtime" / "step14"
V3_SCHEMA = MEMORY_ROOT / "schemas" / "memory_schema_v3.sql"
MIGRATION_MANIFEST = MEMORY_ROOT / "migrations" / "migration_manifest.json"
PRODUCTION = MEMORY_ROOT / "database" / "research_memory.db"
CANONICAL_TEST = MEMORY_ROOT / "tests" / "test_research_memory.db"
DOC_PATH = r"C:\fixtures\step14-search.md"


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _remove_database(path: Path) -> None:
    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm"), Path(f"{path}-journal")):
        candidate.unlink(missing_ok=True)


def _remove_backup(value: dict[str, object]) -> None:
    Path(str(value["backup_database"])).unlink(missing_ok=True)
    Path(str(value["manifest_path"])).unlink(missing_ok=True)


def _seed_current(database: Path) -> dict[str, object]:
    initialize_database(database)
    now1 = "2026-01-01T00:00:00.000Z"
    now2 = "2026-02-01T00:00:00.000Z"
    old_content = "旧版本 GNN localization comparison 指标 0.0136%。\n项目使用 Research Memory 和 SQLite。"
    latest_content = "停止GNN直接定位优化，GNN localization comparison 指标为 0.0136%。\n项目使用 Research Memory 和 SQLite。"
    with closing(sqlite3.connect(database)) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        project_id = connection.execute(
            "INSERT INTO projects(name, description, root_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            ("STAKG-SP", "fixture", r"C:\workspace", "active", now1, now2),
        ).lastrowid
        asset_id = connection.execute(
            "INSERT INTO document_assets(project_id, canonical_path, document_type, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (project_id, DOC_PATH, "markdown_report", "STEP-14 fixture", now1, now2),
        ).lastrowid
        versions: list[int] = []
        chunks: list[str] = []
        for index, (stamp, label, content) in enumerate(
            ((now1, "OLD", old_content), (now2, "LATEST", latest_content)), start=1
        ):
            raw_hash = _hash(content)
            document_id = connection.execute(
                "INSERT INTO documents(project_id, path, type, summary, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (project_id, DOC_PATH, "markdown_report", label, raw_hash, stamp),
            ).lastrowid
            source_id = connection.execute(
                "INSERT INTO sources(project_id, source_type, canonical_path, external_ref, content_hash, source_version, created_at, verified_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
                (project_id, "report", DOC_PATH, raw_hash, label, stamp, stamp),
            ).lastrowid
            version_id = connection.execute(
                """INSERT INTO document_versions(
                    asset_id, memory_document_id, source_id, content_hash, normalized_text_hash,
                    source_version, parser_name, parser_version, chunker_name, chunker_version,
                    chunking_config_json, text_encoding, byte_count, line_count, chunk_count, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'fixture', '1', 'fixture', '1', '{}', 'utf-8', ?, 2, 1, ?)""",
                (asset_id, document_id, source_id, raw_hash, raw_hash, label, len(content.encode("utf-8")), stamp),
            ).lastrowid
            uid = _hash(f"{raw_hash}:1:2:{raw_hash}")
            connection.execute(
                """INSERT INTO document_chunks(
                    document_version_id, chunk_uid, chunk_index, heading_path_json, start_line,
                    end_line, content_hash, content, char_count, metadata_json, created_at
                ) VALUES (?, ?, 0, ?, 1, 2, ?, ?, ?, '{}', ?)""",
                (version_id, uid, json.dumps([label]), raw_hash, content, len(content), stamp),
            )
            versions.append(version_id)
            chunks.append(uid)
        connection.commit()
    rebuild_fts_index(database, create_backup=False)
    return {"project_id": project_id, "asset_id": asset_id, "versions": versions, "chunks": chunks}


def _v3_database(database: Path) -> None:
    with closing(sqlite3.connect(database)) as connection:
        connection.executescript(V3_SCHEMA.read_text(encoding="utf-8"))
        manifest = json.loads(MIGRATION_MANIFEST.read_text(encoding="utf-8"))
        for entry in manifest["migrations"][:2]:
            connection.execute(
                "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
                (entry["version"], entry["name"], entry["sha256"], "2026-01-01T00:00:00.000Z"),
            )
        connection.execute(
            "INSERT INTO projects(name, description, root_path, status, created_at, updated_at) VALUES ('STAKG-SP', 'v3', 'C:\\workspace', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        )
        connection.commit()


class Step14MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        RUNTIME.mkdir(parents=True, exist_ok=True)

    def test_01_sqlite_supports_fts5(self) -> None:
        with closing(sqlite3.connect(":memory:")) as connection:
            connection.execute("CREATE VIRTUAL TABLE probe USING fts5(value)")
            self.assertIn("ENABLE_FTS5", {row[0] for row in connection.execute("PRAGMA compile_options")})

    def test_02_sqlite_supports_trigram(self) -> None:
        with closing(sqlite3.connect(":memory:")) as connection:
            connection.execute("CREATE VIRTUAL TABLE probe USING fts5(value, tokenize='trigram')")
            connection.execute("INSERT INTO probe(value) VALUES ('停止GNN直接定位优化 Research Memory')")
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM probe WHERE probe MATCH ?", ('"直接定位"',)).fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM probe WHERE probe MATCH ?", ('"earch Mem"',)).fetchone()[0], 1)

    def test_03_v3_migrates_to_v4_and_preserves_records(self) -> None:
        database = RUNTIME / f"migration-{uuid4().hex}.db"
        _v3_database(database)
        before = inspect_database(database)
        backup = backup_database(database, label="step14-test-v3")
        try:
            result = migrate_database(database, backup_manifest=backup["manifest_path"])
            after = inspect_database(database)
            self.assertEqual((result["from_version"], result["to_version"]), (3, 4))
            self.assertEqual(before["table_counts"]["projects"], after["table_counts"]["projects"])
            self.assertEqual(after["schema_migrations"][-1]["name"], "document_chunk_fts")
        finally:
            _remove_database(database)
            _remove_backup(backup)

    def test_04_migration_checksum_matches_manifest(self) -> None:
        manifest = json.loads(MIGRATION_MANIFEST.read_text(encoding="utf-8"))
        entry = manifest["migrations"][-1]
        actual = hashlib.sha256((MIGRATION_MANIFEST.parent / entry["file"]).read_bytes()).hexdigest()
        self.assertEqual(actual, entry["sha256"])

    def test_05_current_migration_is_idempotent(self) -> None:
        database = RUNTIME / f"current-{uuid4().hex}.db"
        try:
            initialize_database(database)
            result = migrate_database(database)
            self.assertTrue(result["already_current"])
            self.assertEqual(result["applied"], [])
        finally:
            _remove_database(database)

    def test_06_external_content_table_configuration(self) -> None:
        database = RUNTIME / f"schema-{uuid4().hex}.db"
        try:
            initialize_database(database)
            with closing(sqlite3.connect(database)) as connection:
                sql = connection.execute("SELECT sql FROM sqlite_schema WHERE name='document_chunks_fts'").fetchone()[0]
                self.assertIn("content = 'document_chunks'", sql)
                self.assertIn("tokenize = 'trigram'", sql)
        finally:
            _remove_database(database)

    def test_06a_v4_checksum_mismatch_is_rejected(self) -> None:
        root = MEMORY_ROOT / "migrations" / f".step14-checksum-{uuid4().hex}"
        database = RUNTIME / f"checksum-{uuid4().hex}.db"
        try:
            root.mkdir(parents=True)
            payload = json.loads(MIGRATION_MANIFEST.read_text(encoding="utf-8"))
            for entry in payload["migrations"]:
                shutil.copy2(MIGRATION_MANIFEST.parent / entry["file"], root / entry["file"])
            payload["migrations"][-1]["sha256"] = "0" * 64
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps(payload), encoding="utf-8")
            _v3_database(database)
            with self.assertRaisesRegex(MigrationError, "checksum mismatch"):
                migrate_database(database, manifest_path=manifest)
            self.assertEqual(inspect_database(database)["user_version"], 3)
        finally:
            _remove_database(database)
            shutil.rmtree(root, ignore_errors=True)

    def test_06b_failed_v4_transaction_rolls_back(self) -> None:
        root = MEMORY_ROOT / "migrations" / f".step14-rollback-{uuid4().hex}"
        database = RUNTIME / f"rollback-{uuid4().hex}.db"
        backup: dict[str, object] | None = None
        try:
            root.mkdir(parents=True)
            payload = json.loads(MIGRATION_MANIFEST.read_text(encoding="utf-8"))
            for entry in payload["migrations"][:2]:
                shutil.copy2(MIGRATION_MANIFEST.parent / entry["file"], root / entry["file"])
            failure_sql = "CREATE TABLE rollback_probe(id INTEGER);\nINSERT INTO missing_table(id) VALUES (1);\n"
            (root / "004_failure.sql").write_text(failure_sql, encoding="utf-8")
            payload["migrations"][-1] = {
                "version": 4,
                "name": "document_chunk_fts_failure",
                "file": "004_failure.sql",
                "sha256": hashlib.sha256(failure_sql.encode("utf-8")).hexdigest(),
            }
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps(payload), encoding="utf-8")
            _v3_database(database)
            backup = backup_database(database, label="step14-rollback-v3")
            with self.assertRaises(MigrationError):
                migrate_database(database, backup_manifest=backup["manifest_path"], manifest_path=manifest)
            state = inspect_database(database)
            self.assertEqual(state["user_version"], 3)
            self.assertNotIn("rollback_probe", state["tables"])
        finally:
            _remove_database(database)
            if backup is not None:
                _remove_backup(backup)
            shutil.rmtree(root, ignore_errors=True)


class Step14SearchTests(unittest.TestCase):
    def setUp(self) -> None:
        RUNTIME.mkdir(parents=True, exist_ok=True)
        self.database = RUNTIME / f"query-{uuid4().hex}.db"
        self.ids = _seed_current(self.database)

    def tearDown(self) -> None:
        _remove_database(self.database)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def test_07_state_row_is_valid(self) -> None:
        with closing(self._connect()) as connection:
            self.assertEqual(state_row(connection)["status"], "valid")

    def test_08_insert_trigger_indexes_and_marks_stale(self) -> None:
        content = "insert trigger marker"
        with closing(self._connect()) as connection:
            uid = _hash(content)
            connection.execute(
                "INSERT INTO document_chunks(document_version_id, chunk_uid, chunk_index, heading_path_json, start_line, end_line, content_hash, content, char_count, metadata_json, created_at) VALUES (?, ?, 1, '[]', 3, 3, ?, ?, ?, '{}', '2026-02-01T00:00:00Z')",
                (self.ids["versions"][1], uid, _hash(content), content, len(content)),
            )
            connection.commit()
            self.assertEqual(connection.execute("SELECT status FROM document_chunk_fts_state WHERE id=1").fetchone()[0], "stale")
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM document_chunks_fts_docsize").fetchone()[0], 3)

    def test_09_update_trigger_replaces_index_entry(self) -> None:
        with closing(self._connect()) as connection:
            connection.execute("UPDATE document_chunks SET content='updated trigger marker', content_hash=? WHERE chunk_uid=?", (_hash("updated trigger marker"), self.ids["chunks"][1]))
            connection.commit()
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM document_chunks_fts WHERE document_chunks_fts MATCH ?", ('"updated trigger"',)).fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT status FROM document_chunk_fts_state WHERE id=1").fetchone()[0], "stale")

    def test_10_delete_trigger_removes_index_entry(self) -> None:
        with closing(self._connect()) as connection:
            connection.execute("DELETE FROM document_chunks WHERE chunk_uid=?", (self.ids["chunks"][0],))
            connection.commit()
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM document_chunks_fts_docsize").fetchone()[0], 1)

    def test_11_rebuild_restores_valid_state(self) -> None:
        first = rebuild_fts_index(self.database, create_backup=False)
        self.assertTrue(first["validation"]["valid"])

    def test_12_rebuild_signatures_are_idempotent(self) -> None:
        first = rebuild_fts_index(self.database, create_backup=False)["state"]
        second = rebuild_fts_index(self.database, create_backup=False)["state"]
        self.assertEqual(first["source_signature"], second["source_signature"])
        self.assertEqual(first["index_signature"], second["index_signature"])

    def test_13_offline_validation_passes(self) -> None:
        self.assertTrue(validate_database_fts(self.database)["valid"])

    def test_14_source_and_index_counts_match(self) -> None:
        value = validate_database_fts(self.database)
        self.assertEqual(value["source_chunk_count"], value["indexed_row_count"])

    def test_15_source_signature_is_repeatable(self) -> None:
        with closing(self._connect()) as connection:
            self.assertEqual(computed_state(connection)["source_signature"], computed_state(connection)["source_signature"])

    def test_16_index_signature_is_repeatable(self) -> None:
        with closing(self._connect()) as connection:
            self.assertEqual(computed_state(connection)["index_signature"], computed_state(connection)["index_signature"])

    def test_17_chinese_trigram_query(self) -> None:
        result = search_document_chunks("停止GNN直接定位优化", database=self.database)
        self.assertEqual((result["search_backend"], result["returned_count"]), ("fts5_trigram", 1))

    def test_18_english_trigram_query(self) -> None:
        result = search_document_chunks("localization comparison", database=self.database)
        self.assertEqual(result["returned_count"], 1)

    def test_19_numeric_and_symbol_query(self) -> None:
        result = search_document_chunks("0.0136%", database=self.database)
        self.assertEqual(result["returned_count"], 1)

    def test_20_short_query_uses_scan(self) -> None:
        result = search_document_chunks("项目", database=self.database)
        self.assertEqual(result["search_backend"], "short_query_scan")
        self.assertEqual(result["returned_count"], 1)

    def test_21_phrase_mode(self) -> None:
        self.assertEqual(search_document_chunks("Research Memory", database=self.database, match_mode="phrase")["returned_count"], 1)

    def test_22_all_mode(self) -> None:
        self.assertEqual(search_document_chunks("GNN SQLite", database=self.database, match_mode="all")["returned_count"], 1)

    def test_23_any_mode(self) -> None:
        self.assertEqual(search_document_chunks("GNN absent", database=self.database, match_mode="any")["returned_count"], 1)

    def test_24_project_filter(self) -> None:
        self.assertEqual(search_document_chunks("GNN", database=self.database, project_name="unknown")["returned_count"], 0)

    def test_25_path_filter(self) -> None:
        self.assertEqual(search_document_chunks("GNN", database=self.database, document_path=DOC_PATH)["returned_count"], 1)

    def test_26_asset_filter(self) -> None:
        self.assertEqual(search_document_chunks("GNN", database=self.database, asset_id=self.ids["asset_id"])["returned_count"], 1)

    def test_27_specific_version(self) -> None:
        result = search_document_chunks("GNN", database=self.database, version_scope="specific", document_version_id=self.ids["versions"][0])
        self.assertEqual(result["results"][0]["source_version"], "OLD")

    def test_28_latest_version_is_default(self) -> None:
        result = search_document_chunks("GNN", database=self.database)
        self.assertEqual(result["results"][0]["source_version"], "LATEST")
        self.assertTrue(result["results"][0]["is_latest_version"])

    def test_29_all_versions(self) -> None:
        result = search_document_chunks("GNN", database=self.database, version_scope="all")
        self.assertEqual(result["returned_count"], 2)

    def test_30_specific_requires_version_id(self) -> None:
        with self.assertRaises(MemoryValidationError):
            search_document_chunks("GNN", database=self.database, version_scope="specific")

    def test_31_limit_maximum_is_enforced(self) -> None:
        with self.assertRaises(MemoryValidationError):
            search_document_chunks("GNN", database=self.database, limit=21)

    def test_32_total_character_budget_is_enforced(self) -> None:
        result = search_document_chunks("GNN", database=self.database, max_total_chars=20)
        self.assertLessEqual(result["total_returned_chars"], 20)

    def test_33_empty_result_has_no_citations(self) -> None:
        result = search_document_chunks("THIS_CHUNK_QUERY_SHOULD_NOT_EXIST_987654", database=self.database)
        self.assertEqual(result["status"], "NO_MATCH")
        self.assertEqual(result["results"], [])

    def test_34_sql_injection_text_does_not_change_structure(self) -> None:
        result = search_document_chunks("x' OR 1=1 --", database=self.database)
        self.assertEqual(result["returned_count"], 0)

    def test_35_fts_operator_text_is_literal(self) -> None:
        result = search_document_chunks('NEAR OR content: "GNN"', database=self.database)
        self.assertEqual(result["returned_count"], 0)

    def test_36_nul_query_is_rejected(self) -> None:
        with self.assertRaises(MemoryValidationError):
            parse_search_query("GNN\x00SQLite")

    def test_37_long_query_is_rejected(self) -> None:
        with self.assertRaises(MemoryValidationError):
            parse_search_query("x" * 257)

    def test_38_snippet_has_real_line_bounds_and_citations(self) -> None:
        item = search_document_chunks("0.0136%", database=self.database)["results"][0]
        self.assertLessEqual(item["chunk_start_line"], item["snippet_start_line"])
        self.assertLessEqual(item["snippet_end_line"], item["chunk_end_line"])
        self.assertIn(item["chunk_uid"], item["chunk_citation"])

    def test_39_exact_chunk_read(self) -> None:
        result = get_document_chunk(self.ids["chunks"][1], database=self.database)
        self.assertEqual(result["source_version"], "LATEST")
        self.assertIn("0.0136%", result["content"])

    def test_40_invalid_chunk_uid_is_rejected(self) -> None:
        with self.assertRaises(MemoryValidationError):
            get_document_chunk("invalid", database=self.database)

    def test_41_unknown_chunk_uid_is_not_found(self) -> None:
        with self.assertRaises(MemoryNotFoundError):
            get_document_chunk("0" * 64, database=self.database)

    def test_42_content_can_be_omitted(self) -> None:
        result = get_document_chunk(self.ids["chunks"][1], database=self.database, include_content=False)
        self.assertIsNone(result["content"])
        self.assertFalse(result["content_included"])

    def test_43_read_only_connection_queries_and_rejects_writes(self) -> None:
        uri = f"{self.database.as_uri()}?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as connection:
            connection.execute("PRAGMA query_only=ON")
            self.assertEqual(connection.execute("PRAGMA query_only").fetchone()[0], 1)
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("DELETE FROM document_chunks")

    def test_44_stale_state_blocks_queries(self) -> None:
        with closing(self._connect()) as connection:
            connection.execute("UPDATE document_chunk_fts_state SET status='stale' WHERE id=1")
            connection.commit()
        with self.assertRaises(MemoryStorageError):
            search_document_chunks("GNN", database=self.database)

    def test_45_heading_scope(self) -> None:
        result = search_document_chunks("LATEST", database=self.database, field_scope="heading")
        self.assertEqual(result["returned_count"], 1)


class Step14CanonicalStateTests(unittest.TestCase):
    def test_46_production_index_is_empty_and_valid(self) -> None:
        state = inspect_database(PRODUCTION)
        self.assertEqual(state["user_version"], 4)
        self.assertEqual(state["table_counts"]["document_chunks"], 0)
        self.assertEqual(state["table_counts"]["document_chunks_fts_docsize"], 0)
        self.assertEqual(validate_database_fts(PRODUCTION)["stored_state"]["status"], "valid")

    def test_47_test_index_has_three_chunks_and_is_valid(self) -> None:
        state = inspect_database(CANONICAL_TEST)
        self.assertEqual(state["user_version"], 4)
        self.assertEqual(state["table_counts"]["document_chunks"], 3)
        self.assertEqual(state["table_counts"]["document_chunks_fts_docsize"], 3)
        self.assertTrue(validate_database_fts(CANONICAL_TEST)["valid"])


if __name__ == "__main__":
    unittest.main()
