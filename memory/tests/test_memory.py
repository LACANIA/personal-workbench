"""Integration tests for the first Research Memory foundation."""

from __future__ import annotations

import sqlite3
import unittest
from contextlib import closing
from pathlib import Path

from memory.api.agent_interface import add_memory, get_project_context, query_memory
from memory.api.memory_api import (
    MemoryConstraintError,
    MemoryNotFoundError,
    MemoryPathError,
    MemoryStorageError,
    _connection,
    add_decision,
    add_document,
    add_experiment,
    add_session,
    create_project,
    create_task,
    get_project,
    list_projects,
    query_decisions,
    query_documents,
    query_experiments,
    query_sessions,
    query_tasks,
    update_task,
)
from memory.database.init_db import initialize_database


MEMORY_ROOT = Path(__file__).resolve().parents[1]
TEST_DATABASE = MEMORY_ROOT / "tests" / "runtime" / "test_memory_foundation.db"
TEST_PROJECT_ROOT = MEMORY_ROOT / "tests" / "fixtures" / "STAKG-SP"


class ResearchMemoryIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        TEST_DATABASE.parent.mkdir(parents=True, exist_ok=True)
        canonical_test_db = TEST_DATABASE.resolve(strict=False)
        canonical_test_db.relative_to(MEMORY_ROOT.resolve(strict=True))
        for candidate in (
            canonical_test_db,
            Path(f"{canonical_test_db}-wal"),
            Path(f"{canonical_test_db}-shm"),
        ):
            if candidate.exists():
                candidate.unlink()

        cls.initialization = initialize_database(TEST_DATABASE)
        cls.project = create_project(
            name="STAKG-SP",
            description="LEO Doppler positioning and satellite knowledge graph project",
            root_path=str(TEST_PROJECT_ROOT),
            status="active",
            database=TEST_DATABASE,
        )
        cls.decision = add_decision(
            cls.project["id"],
            title="停止GNN直接定位优化",
            reason="GNN直接定位提升约0.0136%，收益不足，转向语义先验方向",
            evidence="定位实验结果",
            confidence="high",
            database=TEST_DATABASE,
        )
        cls.experiment = add_experiment(
            cls.project["id"],
            name="GNN localization comparison",
            config="baseline comparison",
            result="定位特征优化收益有限",
            metric="0.0136%",
            artifact_path=None,
            database=TEST_DATABASE,
        )
        cls.document = add_document(
            cls.project["id"],
            path="Parent_Project_v0.5.5.pdf",
            type="paper",
            summary="旗舰论文版本",
            hash="sha256:test-value-step-10",
            database=TEST_DATABASE,
        )
        cls.task = create_task(
            cls.project["id"],
            description="整理STAKG-SP实验状态",
            status="completed",
            database=TEST_DATABASE,
        )
        cls.session = add_session(
            cls.task["id"],
            model="qwen3:8b",
            tools="personal-safe-fs",
            result="memory test completed",
            database=TEST_DATABASE,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        for candidate in (
            TEST_DATABASE,
            Path(f"{TEST_DATABASE}-wal"),
            Path(f"{TEST_DATABASE}-shm"),
        ):
            candidate.unlink(missing_ok=True)

    def test_01_database_contains_v3_tables(self) -> None:
        self.assertEqual(self.initialization["integrity_check"], "ok")
        self.assertEqual(self.initialization["encoding"], "UTF-8")
        self.assertTrue(
            {
                "projects", "decisions", "experiments", "documents", "tasks", "sessions",
                "schema_migrations", "sources", "record_sources",
                "document_assets", "document_versions", "document_chunks", "ingest_runs",
                "document_chunks_fts", "document_chunks_fts_vocab", "document_chunk_fts_state",
            }.issubset(set(self.initialization["tables"])),
        )
        self.assertEqual(self.initialization["schema_version"], 4)

    def test_02_project_create_get_and_list(self) -> None:
        by_id = get_project(project_id=self.project["id"], database=TEST_DATABASE)
        by_name = get_project(name="STAKG-SP", database=TEST_DATABASE)
        projects = list_projects(status="active", database=TEST_DATABASE)
        self.assertEqual(by_id, by_name)
        self.assertEqual(by_name["description"], "LEO Doppler positioning and satellite knowledge graph project")
        self.assertEqual(projects, [by_name])
        self.assertTrue(by_name["created_at"].endswith("Z"))
        self.assertTrue(by_name["updated_at"].endswith("Z"))

    def test_03_decision_insert_and_query(self) -> None:
        decisions = query_decisions(
            self.project["id"], confidence="high", database=TEST_DATABASE
        )
        self.assertEqual(decisions, [self.decision])
        self.assertEqual(decisions[0]["title"], "停止GNN直接定位优化")
        self.assertEqual(decisions[0]["evidence"], "定位实验结果")

    def test_04_experiment_insert_and_query(self) -> None:
        experiments = query_experiments(self.project["id"], database=TEST_DATABASE)
        self.assertEqual(experiments, [self.experiment])
        self.assertEqual(experiments[0]["metric"], "0.0136%")

    def test_05_document_insert_and_query(self) -> None:
        documents = query_documents(
            self.project["id"], document_type="paper", database=TEST_DATABASE
        )
        self.assertEqual(documents, [self.document])
        self.assertEqual(documents[0]["path"], "Parent_Project_v0.5.5.pdf")

    def test_06_task_create_update_and_query(self) -> None:
        updated = update_task(self.task["id"], status="completed", database=TEST_DATABASE)
        tasks = query_tasks(self.project["id"], status="completed", database=TEST_DATABASE)
        self.assertEqual(updated["description"], "整理STAKG-SP实验状态")
        self.assertIn(updated, tasks)

    def test_07_session_insert_and_query(self) -> None:
        sessions = query_sessions(
            project_id=self.project["id"], model="qwen3:8b", database=TEST_DATABASE
        )
        self.assertEqual(sessions, [self.session])
        self.assertEqual(sessions[0]["tools"], "personal-safe-fs")
        self.assertEqual(sessions[0]["result"], "memory test completed")

    def test_08_future_agent_interface(self) -> None:
        context = get_project_context("STAKG-SP", database=TEST_DATABASE)
        result = query_memory("0.0136%", database=TEST_DATABASE)
        added = add_memory(
            "decision",
            {
                "project_id": self.project["id"],
                "title": "接口分发测试",
                "reason": "验证add_memory",
                "evidence": {"source": "unittest"},
                "confidence": "medium",
            },
            database=TEST_DATABASE,
        )
        self.assertEqual(context["project"]["name"], "STAKG-SP")
        self.assertEqual(len(context["documents"]), 1)
        self.assertGreaterEqual(result["match_count"], 2)
        self.assertEqual(added["memory_type"], "decision")
        self.assertEqual(added["record"]["evidence"], {"source": "unittest"})

    def test_09_constraints_errors_and_database_boundary(self) -> None:
        with self.assertRaises(MemoryConstraintError):
            create_project(
                name="STAKG-SP",
                description="duplicate",
                root_path=str(TEST_PROJECT_ROOT),
                database=TEST_DATABASE,
            )
        with self.assertRaises(MemoryNotFoundError):
            get_project(name="DOES-NOT-EXIST", database=TEST_DATABASE)
        with self.assertRaises(MemoryPathError):
            list_projects(database=MEMORY_ROOT.parent / "outside-memory.db")

    def test_10_foreign_keys_are_active(self) -> None:
        with self.assertRaises(MemoryConstraintError):
            create_task(
                999_999,
                description="invalid foreign key",
                status="pending",
                database=TEST_DATABASE,
            )
        with closing(sqlite3.connect(TEST_DATABASE)) as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_11_read_only_queries_and_write_rejection(self) -> None:
        project = get_project(
            name="STAKG-SP", database=TEST_DATABASE, read_only=True
        )
        decisions = query_decisions(
            project["id"], database=TEST_DATABASE, read_only=True
        )
        self.assertGreaterEqual(len(decisions), 1)
        with self.assertRaises(MemoryStorageError):
            with _connection(TEST_DATABASE, read_only=True) as connection:
                connection.execute(
                    "INSERT INTO projects(name, description, root_path, status, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("DENIED", "DENIED", "DENIED", "DENIED", "DENIED", "DENIED"),
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
