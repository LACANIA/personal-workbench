"""STEP-12 migration, backup, provenance, filtering, and isolation tests."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from memory.api.agent_interface import get_project_context, query_memory
from memory.api.memory_api import (
    MemoryConstraintError,
    MemoryNotFoundError,
    MemoryStorageError,
    MemoryValidationError,
    _connection,
    add_decision,
    add_document,
    add_experiment,
    add_session,
    add_source,
    create_project,
    create_task,
    get_record_sources,
    get_source,
    link_record_source,
    query_sources,
)
from memory.database.backup_db import backup_database
from memory.database.init_db import MEMORY_ROOT, initialize_database
from memory.database.migrate_db import MigrationError, load_migration_manifest, migrate_database
from memory.database.validate_db import inspect_database
from memory.database.verify_backup import verify_backup


RUNTIME_ROOT = MEMORY_ROOT / "tests" / "runtime"
V1_SCHEMA = MEMORY_ROOT / "schemas" / "memory_schema_v1.sql"
PRODUCTION_DATABASE = MEMORY_ROOT / "database" / "research_memory.db"
TEST_DATABASE = MEMORY_ROOT / "tests" / "test_research_memory.db"
PRODUCTION_V1_MANIFEST = (
    MEMORY_ROOT
    / "backups"
    / "production-v1-pre-migration-20260816T111418646240Z-cf9bcb6f.manifest.json"
)
TEST_V1_MANIFEST = (
    MEMORY_ROOT
    / "backups"
    / "test-v1-pre-migration-20260816T111418698623Z-951b0809.manifest.json"
)
BUSINESS_TABLES = ("projects", "decisions", "experiments", "documents", "tasks", "sessions")


def _runtime_database(label: str) -> Path:
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    return RUNTIME_ROOT / f"{label}-{uuid4().hex}.db"


def _remove_database(path: Path) -> None:
    canonical = path.resolve(strict=False)
    canonical.relative_to(MEMORY_ROOT.resolve(strict=True))
    for candidate in (canonical, Path(f"{canonical}-wal"), Path(f"{canonical}-shm")):
        candidate.unlink(missing_ok=True)


def _remove_backup(result: dict) -> None:
    for key in ("backup_database", "manifest_path"):
        path = Path(result[key]).resolve(strict=False)
        path.relative_to((MEMORY_ROOT / "backups").resolve(strict=True))
        path.unlink(missing_ok=True)


def _create_v1_database(path: Path) -> dict:
    _remove_database(path)
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(V1_SCHEMA.read_text(encoding="utf-8"))
        now = "2026-08-16T00:00:00.000Z"
        project_id = connection.execute(
            """
            INSERT INTO projects(name, description, root_path, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("MIGRATION-PROJECT", "migration fixture", "E:/fixture", "active", now, now),
        ).lastrowid
        decision_id = connection.execute(
            """
            INSERT INTO decisions(project_id, title, reason, evidence, confidence, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (project_id, "fixture decision", "reason", "evidence", "high", now),
        ).lastrowid
        experiment_id = connection.execute(
            """
            INSERT INTO experiments(project_id, name, config, result, metric, artifact_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (project_id, "fixture experiment", "config", "result", "1", None, now),
        ).lastrowid
        document_id = connection.execute(
            """
            INSERT INTO documents(project_id, path, type, summary, hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (project_id, "fixture.md", "report", "summary", "fixture-hash", now),
        ).lastrowid
        task_id = connection.execute(
            "INSERT INTO tasks(project_id, description, status, created_at) VALUES (?, ?, ?, ?)",
            (project_id, "fixture task", "completed", now),
        ).lastrowid
        session_id = connection.execute(
            "INSERT INTO sessions(task_id, model, tools, result, created_at) VALUES (?, ?, ?, ?, ?)",
            (task_id, "qwen3:8b", "memory_query", "fixture result", now),
        ).lastrowid
        connection.commit()
        counts = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in BUSINESS_TABLES
        }
        return {
            "ids": {
                "projects": project_id,
                "decisions": decision_id,
                "experiments": experiment_id,
                "documents": document_id,
                "tasks": task_id,
                "sessions": session_id,
            },
            "counts": counts,
        }
    finally:
        connection.close()


class MigrationAndBackupTests(unittest.TestCase):
    def test_v1_migration_preserves_records_and_is_idempotent(self) -> None:
        database = _runtime_database("migration-success")
        fixture = _create_v1_database(database)
        backup = backup_database(database, label="step12-unittest-v1")
        try:
            result = migrate_database(database, backup_manifest=backup["manifest_path"])
            repeat = migrate_database(database)
            state = inspect_database(database)
            self.assertEqual(result["from_version"], 1)
            self.assertEqual(result["to_version"], 4)
            self.assertEqual(result["business_counts"], fixture["counts"])
            self.assertEqual(repeat["applied"], [])
            self.assertTrue(repeat["already_current"])
            self.assertEqual(state["user_version"], 4)
            self.assertEqual(len(state["schema_migrations"]), 3)
            self.assertEqual(state["integrity_check"], ["ok"])
            self.assertEqual(state["foreign_key_check"], [])
            with closing(sqlite3.connect(database)) as connection:
                for table, record_id in fixture["ids"].items():
                    self.assertIsNotNone(
                        connection.execute(f"SELECT 1 FROM {table} WHERE id = ?", (record_id,)).fetchone()
                    )
        finally:
            _remove_database(database)
            _remove_backup(backup)

    def test_checksum_mismatch_is_rejected(self) -> None:
        test_root = MEMORY_ROOT / "migrations" / f".step12-checksum-{uuid4().hex}"
        test_root.mkdir(parents=True)
        manifest_path = test_root / "manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "manifest_version": 1,
                    "latest_schema_version": 2,
                    "migrations": [
                        {
                            "version": 2,
                            "name": "provenance",
                            "file": "../002_provenance.sql",
                            "sha256": "0" * 64,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        try:
            with self.assertRaises(MigrationError):
                load_migration_manifest(manifest_path)
        finally:
            manifest_path.unlink(missing_ok=True)
            test_root.rmdir()

    def test_failed_migration_rolls_back(self) -> None:
        database = _runtime_database("migration-rollback")
        fixture = _create_v1_database(database)
        backup = backup_database(database, label="step12-unittest-rollback")
        test_root = MEMORY_ROOT / "migrations" / f".step12-rollback-{uuid4().hex}"
        test_root.mkdir(parents=True)
        sql_path = test_root / "002_failure.sql"
        manifest_path = test_root / "manifest.json"
        sql = """
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );
        CREATE TABLE rollback_probe(id INTEGER PRIMARY KEY);
        INSERT INTO missing_table(value) VALUES ('force rollback');
        """
        sql_path.write_text(sql, encoding="utf-8")
        manifest_path.write_text(
            json.dumps(
                {
                    "manifest_version": 1,
                    "latest_schema_version": 2,
                    "migrations": [
                        {
                            "version": 2,
                            "name": "forced_failure",
                            "file": sql_path.name,
                            "sha256": hashlib.sha256(sql.encode("utf-8")).hexdigest(),
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        try:
            with self.assertRaises(MigrationError):
                migrate_database(
                    database,
                    backup_manifest=backup["manifest_path"],
                    manifest_path=manifest_path,
                )
            state = inspect_database(database)
            self.assertEqual(state["user_version"], 1)
            self.assertEqual(
                {table: state["table_counts"][table] for table in BUSINESS_TABLES},
                fixture["counts"],
            )
            self.assertNotIn("rollback_probe", state["tables"])
            self.assertNotIn("schema_migrations", state["tables"])
        finally:
            _remove_database(database)
            _remove_backup(backup)
            manifest_path.unlink(missing_ok=True)
            sql_path.unlink(missing_ok=True)
            test_root.rmdir()

    def test_backup_manifest_and_temporary_restore(self) -> None:
        database = _runtime_database("backup-restore")
        initialize_database(database)
        create_project("BACKUP-PROJECT", "fixture", "E:/fixture", database=database)
        backup = backup_database(database, label="step12-unittest-v2")
        try:
            verification = verify_backup(backup["manifest_path"], expect_project="BACKUP-PROJECT")
            self.assertTrue(verification["valid"])
            self.assertTrue(verification["temporary_restore_removed"])
            self.assertTrue(verification["project_found"])
            self.assertEqual(backup["schema_version"], 4)
            self.assertEqual(backup["integrity_check"], ["ok"])
            self.assertEqual(backup["foreign_key_check"], [])
            self.assertNotEqual(backup["source_database"], backup["backup_database"])
        finally:
            _remove_database(database)
            _remove_backup(backup)

    @unittest.skipUnless(
        PRODUCTION_V1_MANIFEST.is_file() and TEST_V1_MANIFEST.is_file(),
        "formal pre-migration backups are local acceptance evidence and are not published",
    )
    def test_formal_v1_backups_restore(self) -> None:
        production = verify_backup(PRODUCTION_V1_MANIFEST)
        test = verify_backup(TEST_V1_MANIFEST, expect_project="STAKG-SP")
        self.assertTrue(production["valid"])
        self.assertTrue(test["valid"])
        self.assertTrue(test["project_found"])


class ProvenanceApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = _runtime_database("provenance-api")
        initialize_database(self.database)
        self.project = create_project("P1", "project one", "E:/p1", database=self.database)
        self.other_project = create_project("P2", "project two", "E:/p2", database=self.database)
        self.decision = add_decision(
            self.project["id"], "needle decision", "0.0136%", "evidence", "high", database=self.database
        )
        self.second_decision = add_decision(
            self.project["id"], "needle second", "0.0136%", "evidence", "medium", database=self.database
        )
        self.other_decision = add_decision(
            self.other_project["id"], "needle other", "0.0136%", "evidence", "low", database=self.database
        )
        self.experiment = add_experiment(
            self.project["id"], "needle experiment", "config", "result", "0.0136%", database=self.database
        )
        self.document = add_document(
            self.project["id"], "fixture.pdf", "paper", "needle document", "hash", database=self.database
        )
        task = create_task(self.project["id"], "needle task", database=self.database)
        self.session = add_session(task["id"], "qwen3:8b", "memory_query", "needle result", database=self.database)
        self.source = add_source(
            "report",
            project_id=self.project["id"],
            canonical_path="C:/workspace/reports/fixture.md",
            content_hash="fixture-hash",
            source_version="fixture",
            database=self.database,
        )
        self.second_source = add_source(
            "external_reference",
            external_ref="urn:step12:fixture",
            database=self.database,
        )

    def tearDown(self) -> None:
        _remove_database(self.database)

    def test_source_create_get_and_query(self) -> None:
        self.assertEqual(get_source(self.source["id"], database=self.database), self.source)
        found = query_sources(
            project_id=self.project["id"], source_type="report", database=self.database
        )
        self.assertEqual(found, [self.source])

    def test_many_to_many_links_and_duplicate_rejection(self) -> None:
        first = link_record_source(
            "decision", self.decision["id"], self.source["id"],
            role="supports", locator_type="line", locator_start=10, locator_end=12,
            database=self.database,
        )
        link_record_source(
            "decision", self.decision["id"], self.second_source["id"],
            role="context", locator_type="section", locator_json={"section": "A"},
            database=self.database,
        )
        link_record_source(
            "experiment", self.experiment["id"], self.source["id"],
            role="supports", locator_type="line", locator_start=20, locator_end=20,
            database=self.database,
        )
        self.assertEqual(len(get_record_sources("decision", self.decision["id"], database=self.database)), 2)
        self.assertEqual(len(get_record_sources("experiment", self.experiment["id"], database=self.database)), 1)
        with self.assertRaises(MemoryConstraintError):
            link_record_source(
                "decision", self.decision["id"], self.source["id"],
                role="supports", locator_type="line", locator_start=10, locator_end=12,
                database=self.database,
            )
        self.assertEqual(first["entity_id"], self.decision["id"])

    def test_invalid_entity_and_missing_records_are_rejected(self) -> None:
        with self.assertRaises(MemoryValidationError):
            link_record_source(
                "invalid", 1, self.source["id"], role="supports", locator_type="line",
                database=self.database,
            )
        with self.assertRaises(MemoryNotFoundError):
            link_record_source(
                "decision", 999999, self.source["id"], role="supports", locator_type="line",
                database=self.database,
            )
        with self.assertRaises(MemoryNotFoundError):
            link_record_source(
                "decision", self.decision["id"], 999999, role="supports", locator_type="line",
                database=self.database,
            )

    def test_query_filters_limits_and_sources(self) -> None:
        link_record_source(
            "decision", self.decision["id"], self.source["id"],
            role="supports", locator_type="line", locator_start=10, locator_end=12,
            verification_status="verified", database=self.database,
        )
        result = query_memory(
            "0.0136%",
            database=self.database,
            read_only=True,
            entity_types=["decision", "experiment"],
            project_name="P1",
            limit_per_type=1,
            include_sources=True,
        )
        self.assertEqual(result["applied_filters"]["entity_types"], ["decision", "experiment"])
        self.assertEqual(result["applied_filters"]["project_name"], "P1")
        self.assertEqual(result["counts"], {"decisions": 2, "experiments": 1})
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["records"]["decisions"]), 1)
        self.assertEqual(result["records"]["decisions"][0]["sources"][0]["source"]["id"], self.source["id"])
        with self.assertRaises(MemoryValidationError):
            query_memory("needle", database=self.database, limit_per_type=101)
        with self.assertRaises(MemoryValidationError):
            query_memory("needle", database=self.database, entity_types=["unknown"])

    def test_project_context_returns_counts_truncation_and_sources(self) -> None:
        link_record_source(
            "document", self.document["id"], self.source["id"],
            role="supports", locator_type="page", locator_start=3, locator_end=3,
            database=self.database,
        )
        context = get_project_context(
            "P1",
            database=self.database,
            read_only=True,
            include_sources=True,
            limit_per_entity=1,
        )
        self.assertEqual(context["counts"]["decisions"], 2)
        self.assertEqual(context["returned_counts"]["decisions"], 1)
        self.assertTrue(context["truncated"])
        self.assertEqual(context["documents"][0]["sources"][0]["locator_start"], 3)

    def test_read_only_connection_rejects_write(self) -> None:
        with _connection(self.database, read_only=True) as connection:
            self.assertEqual(connection.execute("PRAGMA query_only").fetchone()[0], 1)
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("INSERT INTO sources(source_type, external_ref, created_at) VALUES ('x', 'y', 'z')")


class CanonicalDatabaseSeparationTests(unittest.TestCase):
    def test_production_database_has_no_sample_records(self) -> None:
        state = inspect_database(PRODUCTION_DATABASE)
        self.assertEqual(state["user_version"], 4)
        self.assertEqual({table: state["table_counts"][table] for table in BUSINESS_TABLES}, {table: 0 for table in BUSINESS_TABLES})
        self.assertEqual(state["table_counts"]["sources"], 0)
        self.assertEqual(state["table_counts"]["record_sources"], 0)

    def test_test_database_has_sample_and_provenance_records(self) -> None:
        state = inspect_database(TEST_DATABASE)
        self.assertEqual(state["user_version"], 4)
        self.assertEqual(state["table_counts"]["projects"], 1)
        self.assertEqual(state["table_counts"]["sources"], 1)
        self.assertGreaterEqual(state["table_counts"]["record_sources"], 3)
        project = get_project_context(
            "STAKG-SP", database=TEST_DATABASE, read_only=True, include_sources=True
        )
        self.assertEqual(project["project"]["name"], "STAKG-SP")
        self.assertEqual(project["decisions"][0]["id"], 1)
        self.assertEqual(project["experiments"][0]["id"], 1)
        self.assertEqual(project["documents"][0]["id"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
