"""STEP-13 controlled document-ingestion, migration, and safety tests."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing, redirect_stdout
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from memory.api.memory_api import add_source, create_project
from memory.database.backup_db import BACKUP_ROOT, backup_database
from memory.database.init_db import MEMORY_ROOT, initialize_database
from memory.database.migrate_db import MigrationError, load_migration_manifest, migrate_database
from memory.database.validate_db import inspect_database
from memory.ingest.document_chunker import chunk_document, validate_chunks
from memory.ingest.document_ingest import main as ingest_cli_main
from memory.ingest.document_parser import parse_document
from memory.ingest.errors import IngestError
from memory.ingest.ingest_api import (
    CANONICAL_TEST_DATABASE,
    PRODUCTION_DATABASE,
    commit_document_ingest,
    get_document_asset,
    get_document_version,
    list_document_chunks,
    list_document_versions,
    preview_document_ingest,
    search_document_chunks,
)
from memory.ingest.ingest_manifest import sha256_file
from memory.ingest.path_policy import DEFAULT_POLICY_PATH, MAX_FILE_BYTES, PathPolicy


RUNTIME_ROOT = MEMORY_ROOT / "tests" / "runtime" / "step13"
V2_SCHEMA = MEMORY_ROOT / "schemas" / "memory_schema_v2.sql"
MIGRATION_MANIFEST = MEMORY_ROOT / "migrations" / "migration_manifest.json"
V2_SCHEMA_SHA256 = "cecd1088ef0544a9e2227fe4a4cb59a89ec192a0186bd2f5a27e960d22edde64"


def _remove_database(path: Path) -> None:
    canonical = path.resolve(strict=False)
    canonical.relative_to(MEMORY_ROOT.resolve(strict=True))
    for candidate in (canonical, Path(f"{canonical}-wal"), Path(f"{canonical}-shm")):
        candidate.unlink(missing_ok=True)


def _remove_backup(result: dict) -> None:
    for key in ("backup_database", "manifest_path"):
        candidate = Path(result[key]).resolve(strict=False)
        candidate.relative_to(BACKUP_ROOT.resolve(strict=True))
        candidate.unlink(missing_ok=True)


def _v2_database(path: Path) -> dict[str, int]:
    _remove_database(path)
    manifest = json.loads(MIGRATION_MANIFEST.read_text(encoding="utf-8"))
    migration_v2 = next(item for item in manifest["migrations"] if item["version"] == 2)
    now = "2026-08-16T00:00:00.000Z"
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(V2_SCHEMA.read_text(encoding="utf-8"))
        connection.execute(
            "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (2, ?, ?, ?)",
            (migration_v2["name"], migration_v2["sha256"], now),
        )
        project_id = connection.execute(
            """
            INSERT INTO projects(name, description, root_path, status, created_at, updated_at)
            VALUES ('V2-PROJECT', 'fixture', 'C:/workspace', 'active', ?, ?)
            """,
            (now, now),
        ).lastrowid
        document_id = connection.execute(
            """
            INSERT INTO documents(project_id, path, type, summary, hash, created_at)
            VALUES (?, 'fixture.md', 'report', 'summary', 'fixture-hash', ?)
            """,
            (project_id, now),
        ).lastrowid
        source_id = connection.execute(
            """
            INSERT INTO sources(project_id, source_type, canonical_path, content_hash, source_version,
                                created_at, verified_at)
            VALUES (?, 'report', 'C:/workspace/fixture.md', 'fixture-hash', 'v1', ?, ?)
            """,
            (project_id, now, now),
        ).lastrowid
        link_id = connection.execute(
            """
            INSERT INTO record_sources(
                entity_type, entity_id, source_id, role, locator_type, locator_start, locator_end,
                verification_status, created_at, verified_at
            ) VALUES ('document', ?, ?, 'supports', 'line', 1, 1, 'verified', ?, ?)
            """,
            (document_id, source_id, now, now),
        ).lastrowid
        connection.commit()
    return {
        "project_id": project_id,
        "document_id": document_id,
        "source_id": source_id,
        "link_id": link_id,
    }


class Step13TestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.case_root = RUNTIME_ROOT / uuid4().hex
        self.case_root.mkdir(parents=True)
        self.database = self.case_root / "memory.db"
        initialize_database(self.database)
        self.project = create_project(
            "STEP13-TEST", "document ingestion fixture", str(self.case_root), database=self.database
        )
        self.source_file = self.case_root / "source.md"
        self.source_file.write_text(
            "# Root\n\nAlpha marker\n\n## Section\n\n```python\nprint('x')\n```\n\nOmega marker\n",
            encoding="utf-8",
        )
        self.manifest_root = self.case_root / "manifests"
        self.policy = PathPolicy.load(DEFAULT_POLICY_PATH)
        self.backups_before = set(BACKUP_ROOT.glob("step13-ingest-test-fixture-*"))
        self.outside_root = Path(tempfile.gettempdir()) / f"STEP13_POLICY_DENY_{uuid4().hex}"

    def tearDown(self) -> None:
        current = set(BACKUP_ROOT.glob("step13-ingest-test-fixture-*"))
        for path in current.difference(self.backups_before):
            path.unlink(missing_ok=True)
        if self.outside_root.exists():
            shutil.rmtree(self.outside_root)
        if self.case_root.exists():
            shutil.rmtree(self.case_root)

    def preview(self, **overrides: object) -> dict:
        arguments: dict[str, object] = {
            "database": self.database,
            "project_name": self.project["name"],
            "file_path": self.source_file,
            "source_version": "fixture-v1",
            "summary": "deterministic fixture summary",
            "policy_path": DEFAULT_POLICY_PATH,
            "manifest_directory": self.manifest_root,
        }
        arguments.update(overrides)
        return preview_document_ingest(**arguments)

    def commit(self, preview: dict, **overrides: object) -> dict:
        arguments: dict[str, object] = {
            "manifest_path": preview["manifest_path"],
            "manifest_sha256": preview["manifest_sha256"],
        }
        arguments.update(overrides)
        return commit_document_ingest(**arguments)

    def test_01_frozen_v2_schema_hash_matches_baseline(self) -> None:
        self.assertEqual(sha256_file(V2_SCHEMA), V2_SCHEMA_SHA256)

    def test_02_fresh_database_uses_current_schema(self) -> None:
        state = inspect_database(self.database)
        self.assertEqual(state["user_version"], 4)
        self.assertEqual(len(state["schema_migrations"]), 3)
        for table in ("document_assets", "document_versions", "document_chunks", "ingest_runs"):
            self.assertIn(table, state["tables"])

    def test_03_v2_migration_preserves_ids_and_counts(self) -> None:
        database = self.case_root / "v2.db"
        ids = _v2_database(database)
        before = inspect_database(database)
        backup = backup_database(database, label="step13-unittest-v2")
        try:
            result = migrate_database(database, backup_manifest=backup["manifest_path"])
            after = inspect_database(database)
            self.assertEqual(result["from_version"], 2)
            self.assertEqual(result["to_version"], 4)
            self.assertEqual(after["user_version"], 4)
            for table in ("projects", "documents", "sources", "record_sources"):
                self.assertEqual(after["table_counts"][table], before["table_counts"][table])
            with closing(sqlite3.connect(database)) as connection:
                self.assertIsNotNone(connection.execute("SELECT 1 FROM projects WHERE id = ?", (ids["project_id"],)).fetchone())
                self.assertIsNotNone(connection.execute("SELECT 1 FROM documents WHERE id = ?", (ids["document_id"],)).fetchone())
                self.assertIsNotNone(connection.execute("SELECT 1 FROM sources WHERE id = ?", (ids["source_id"],)).fetchone())
                self.assertIsNotNone(connection.execute("SELECT 1 FROM record_sources WHERE id = ?", (ids["link_id"],)).fetchone())
        finally:
            _remove_backup(backup)

    def test_04_v3_migration_is_idempotent(self) -> None:
        result = migrate_database(self.database)
        self.assertTrue(result["already_current"])
        self.assertEqual(result["applied"], [])

    def test_05_migration_requires_backup(self) -> None:
        database = self.case_root / "v2-no-backup.db"
        _v2_database(database)
        with self.assertRaisesRegex(MigrationError, "backup manifest"):
            migrate_database(database)

    def test_06_migration_checksum_mismatch_is_rejected(self) -> None:
        root = MEMORY_ROOT / "migrations" / f".step13-checksum-{uuid4().hex}"
        root.mkdir()
        sql = root / "003.sql"
        sql.write_text("CREATE TABLE checksum_probe(id INTEGER);\n", encoding="utf-8")
        manifest = json.loads(MIGRATION_MANIFEST.read_text(encoding="utf-8"))
        manifest["migrations"][1]["file"] = str(Path(root.name) / sql.name).replace("\\", "/")
        manifest["migrations"][1]["sha256"] = "0" * 64
        manifest_path = MEMORY_ROOT / "migrations" / f"step13-checksum-{uuid4().hex}.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        try:
            with self.assertRaises(MigrationError):
                load_migration_manifest(manifest_path)
        finally:
            manifest_path.unlink(missing_ok=True)
            shutil.rmtree(root)

    def test_07_failed_v3_migration_rolls_back(self) -> None:
        database = self.case_root / "v2-rollback.db"
        _v2_database(database)
        backup = backup_database(database, label="step13-unittest-rollback")
        root = MEMORY_ROOT / "migrations" / f".step13-rollback-{uuid4().hex}"
        root.mkdir()
        failure_sql = "CREATE TABLE rollback_probe(id INTEGER);\nINSERT INTO missing_table(value) VALUES ('x');\n"
        sql_path = root / "003_failure.sql"
        sql_path.write_text(failure_sql, encoding="utf-8")
        original = json.loads(MIGRATION_MANIFEST.read_text(encoding="utf-8"))
        original["migrations"][1] = {
            "version": 3,
            "name": "document_ingestion_failure",
            "file": str(Path(root.name) / sql_path.name).replace("\\", "/"),
            "sha256": hashlib.sha256(failure_sql.encode("utf-8")).hexdigest(),
        }
        manifest_path = MEMORY_ROOT / "migrations" / f"step13-rollback-{uuid4().hex}.json"
        manifest_path.write_text(json.dumps(original), encoding="utf-8")
        try:
            with self.assertRaises(MigrationError):
                migrate_database(database, backup_manifest=backup["manifest_path"], manifest_path=manifest_path)
            state = inspect_database(database)
            self.assertEqual(state["user_version"], 2)
            self.assertNotIn("rollback_probe", state["tables"])
        finally:
            _remove_backup(backup)
            manifest_path.unlink(missing_ok=True)
            shutil.rmtree(root)

    def test_08_allowed_utf8_markdown_is_read(self) -> None:
        document = self.policy.read_document(self.source_file)
        self.assertEqual(document.text_encoding, "utf-8")
        self.assertEqual(document.line_count, 11)
        self.assertEqual(document.canonical_path, str(self.source_file.resolve()))

    def test_09_utf8_bom_and_crlf_are_normalized(self) -> None:
        path = self.case_root / "bom.txt"
        path.write_bytes(b"\xef\xbb\xbfalpha\r\nbeta\r")
        document = self.policy.read_document(path)
        self.assertEqual(document.text_encoding, "utf-8-sig")
        self.assertEqual(document.normalized_text, "alpha\nbeta\n")
        self.assertNotEqual(document.content_hash, document.normalized_text_hash)

    def test_10_invalid_utf8_is_rejected(self) -> None:
        path = self.case_root / "invalid.txt"
        path.write_bytes(b"\xff\xfeinvalid")
        with self.assertRaisesRegex(IngestError, "valid UTF-8") as caught:
            self.policy.read_document(path)
        self.assertEqual(caught.exception.code, "INVALID_UTF8")

    def test_11_nul_content_is_rejected(self) -> None:
        path = self.case_root / "nul.txt"
        path.write_bytes(b"alpha\x00beta")
        with self.assertRaises(IngestError) as caught:
            self.policy.read_document(path)
        self.assertEqual(caught.exception.code, "NUL_BYTE_DENIED")

    def test_12_unsupported_extension_and_directory_are_rejected(self) -> None:
        unsupported = self.case_root / "file.pdf"
        unsupported.write_text("text", encoding="utf-8")
        with self.assertRaises(IngestError) as caught:
            self.policy.read_document(unsupported)
        self.assertEqual(caught.exception.code, "UNSUPPORTED_EXTENSION")
        with self.assertRaises(IngestError) as caught:
            self.policy.read_document(self.case_root)
        self.assertEqual(caught.exception.code, "PATH_TYPE_MISMATCH")

    def test_13_outside_absolute_path_and_traversal_are_rejected(self) -> None:
        self.outside_root.mkdir()
        outside = self.outside_root / "deny.txt"
        outside.write_text("DENY_MARKER", encoding="utf-8")
        for candidate in (
            outside,
            self.outside_root / ".." / self.outside_root.name / "deny.txt",
        ):
            with self.assertRaises(IngestError) as caught:
                self.policy.read_document(candidate)
            self.assertEqual(caught.exception.code, "PATH_POLICY_DENIED")
            self.assertNotIn("DENY_MARKER", str(caught.exception))

    def test_14_unc_device_and_ads_paths_are_rejected(self) -> None:
        candidates = (
            r"\\localhost\C$\workspace\file.txt",
            r"\\?\C:\workspace\file.txt",
            r"C:\workspace\file.txt:secret",
        )
        for candidate in candidates:
            with self.assertRaises(IngestError) as caught:
                self.policy.read_document(candidate)
            self.assertEqual(caught.exception.code, "PATH_POLICY_DENIED")

    def test_15_file_over_five_mib_is_rejected(self) -> None:
        path = self.case_root / "large.txt"
        with path.open("wb") as handle:
            handle.seek(MAX_FILE_BYTES)
            handle.write(b"x")
        with self.assertRaises(IngestError) as caught:
            self.policy.read_document(path)
        self.assertEqual(caught.exception.code, "FILE_TOO_LARGE")

    def test_16_symlink_or_junction_escape_is_rejected(self) -> None:
        self.outside_root.mkdir()
        outside = self.outside_root / "deny.txt"
        outside.write_text("DENY", encoding="utf-8")
        link = self.case_root / "outside-link"
        try:
            os.symlink(self.outside_root, link, target_is_directory=True)
        except OSError:
            created = subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(self.outside_root)],
                check=False,
                capture_output=True,
                text=True,
            )
            if created.returncode != 0:
                self.fail(f"junction creation failed: {created.stderr or created.stdout}")
        try:
            with self.assertRaises(IngestError) as caught:
                self.policy.read_document(link / "deny.txt")
            self.assertEqual(caught.exception.code, "PATH_POLICY_DENIED")
        finally:
            os.rmdir(link)

    def test_17_markdown_parser_tracks_headings_and_fences(self) -> None:
        parsed = parse_document(self.policy.read_document(self.source_file))
        self.assertEqual(parsed.lines[0].heading_path, ("Root",))
        section = next(line for line in parsed.lines if line.text == "## Section")
        self.assertEqual(section.heading_path, ("Root", "Section"))
        code = next(line for line in parsed.lines if "print" in line.text)
        self.assertTrue(code.in_fence_before)
        self.assertTrue(code.in_fence_after)

    def test_18_chunks_cover_every_line_once(self) -> None:
        parsed = parse_document(self.policy.read_document(self.source_file))
        chunks, _ = chunk_document(parsed, {"max_lines": 4, "max_chars": 100})
        validate_chunks(parsed, chunks)
        covered = [line for chunk in chunks for line in range(chunk.start_line, chunk.end_line + 1)]
        self.assertEqual(covered, list(range(1, len(parsed.lines) + 1)))

    def test_19_chunk_generation_is_deterministic(self) -> None:
        parsed = parse_document(self.policy.read_document(self.source_file))
        first, first_config = chunk_document(parsed)
        second, second_config = chunk_document(parsed)
        self.assertEqual(first, second)
        self.assertEqual(first_config, second_config)

    def test_20_fenced_code_boundary_can_form_marked_oversize_chunk(self) -> None:
        path = self.case_root / "fence.md"
        path.write_text("# A\n```\n1\n2\n3\n4\n5\n```\nend\n", encoding="utf-8")
        parsed = parse_document(self.policy.read_document(path))
        chunks, _ = chunk_document(parsed, {"max_lines": 3, "max_chars": 20})
        self.assertTrue(any(chunk.metadata["boundary_extended_for_fence"] for chunk in chunks))
        self.assertTrue(any(chunk.metadata["exceeds_max_lines"] for chunk in chunks))

    def test_21_chunk_gap_overlap_and_hash_errors_are_detected(self) -> None:
        parsed = parse_document(self.policy.read_document(self.source_file))
        chunks, _ = chunk_document(parsed, {"max_lines": 4})
        self.assertGreaterEqual(len(chunks), 2)
        with self.assertRaises(IngestError) as gap:
            validate_chunks(parsed, [chunks[0], replace(chunks[1], start_line=chunks[1].start_line + 1), *chunks[2:]])
        self.assertEqual(gap.exception.code, "CHUNK_GAP")
        with self.assertRaises(IngestError) as overlap:
            validate_chunks(parsed, [chunks[0], replace(chunks[1], start_line=chunks[1].start_line - 1), *chunks[2:]])
        self.assertEqual(overlap.exception.code, "CHUNK_OVERLAP")
        with self.assertRaises(IngestError) as mismatch:
            validate_chunks(parsed, [replace(chunks[0], content_hash="0" * 64), *chunks[1:]])
        self.assertEqual(mismatch.exception.code, "CHUNK_HASH_MISMATCH")

    def test_22_preview_does_not_change_database(self) -> None:
        before = (sha256_file(self.database), self.database.stat().st_size, self.database.stat().st_mtime_ns)
        result = self.preview()
        after = (sha256_file(self.database), self.database.stat().st_size, self.database.stat().st_mtime_ns)
        self.assertEqual(result["status"], "DRY_RUN_READY")
        self.assertTrue(result["database_unchanged"])
        self.assertEqual(after, before)

    def test_23_manifest_has_required_hashes_and_bounded_previews(self) -> None:
        result = self.preview()
        manifest = result["manifest"]
        self.assertEqual(manifest["content_hash"], sha256_file(self.source_file))
        self.assertEqual(manifest["chunk_count"], len(manifest["chunks"]))
        self.assertTrue(all(len(chunk["preview"]) <= 240 for chunk in manifest["chunks"]))
        self.assertNotIn("content", manifest["chunks"][0])

    def test_24_repeated_preview_has_identical_chunk_identity(self) -> None:
        first = self.preview()
        second = self.preview()
        self.assertEqual(first["manifest"]["chunks"], second["manifest"]["chunks"])
        self.assertEqual(first["manifest"]["chunk_signature"], second["manifest"]["chunk_signature"])

    def test_25_cli_defaults_to_preview(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            code = ingest_cli_main(
                [
                    "--database", str(self.database),
                    "--project", self.project["name"],
                    "--file", str(self.source_file),
                    "--source-version", "fixture-v1",
                    "--summary", "deterministic fixture summary",
                    "--manifest-directory", str(self.manifest_root),
                ]
            )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "DRY_RUN_READY")

    def test_26_manifest_tampering_and_wrong_sha_are_rejected(self) -> None:
        preview = self.preview()
        with self.assertRaises(IngestError) as wrong:
            commit_document_ingest(
                manifest_path=preview["manifest_path"], manifest_sha256="0" * 64
            )
        self.assertEqual(wrong.exception.code, "MANIFEST_SHA_MISMATCH")
        path = Path(preview["manifest_path"])
        path.write_text(path.read_text(encoding="utf-8") + " ", encoding="utf-8")
        with self.assertRaises(IngestError) as tampered:
            self.commit(preview)
        self.assertEqual(tampered.exception.code, "MANIFEST_SHA_MISMATCH")

    def test_27_source_change_after_preview_is_rejected(self) -> None:
        preview = self.preview()
        self.source_file.write_text("changed after preview\n", encoding="utf-8")
        with self.assertRaises(IngestError) as caught:
            self.commit(preview)
        self.assertEqual(caught.exception.code, "SOURCE_CHANGED_AFTER_PREVIEW")
        self.assertEqual(inspect_database(self.database)["table_counts"]["document_versions"], 0)

    def test_28_missing_project_and_missing_manifest_are_rejected(self) -> None:
        with self.assertRaises(IngestError) as missing_project:
            self.preview(project_name="UNKNOWN")
        self.assertEqual(missing_project.exception.code, "PROJECT_NOT_FOUND")
        with self.assertRaises(IngestError) as missing_manifest:
            commit_document_ingest(manifest_path=None, manifest_sha256=None)
        self.assertEqual(missing_manifest.exception.code, "MANIFEST_REQUIRED")

    def test_29_production_commit_requires_explicit_confirmation(self) -> None:
        preview = self.preview()
        payload = json.loads(Path(preview["manifest_path"]).read_text(encoding="utf-8"))
        payload["database_path"] = str(PRODUCTION_DATABASE)
        path = self.manifest_root / "production.manifest.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        with self.assertRaises(IngestError) as caught:
            commit_document_ingest(manifest_path=path, manifest_sha256=sha256_file(path))
        self.assertEqual(caught.exception.code, "PRODUCTION_WRITE_CONFIRMATION_REQUIRED")

    def test_30_commit_creates_complete_document_graph(self) -> None:
        preview = self.preview()
        result = self.commit(preview)
        self.assertEqual(result["status"], "COMMITTED")
        self.assertTrue(result["backup_verification"]["valid"])
        asset = get_document_asset(database=self.database, asset_id=result["asset_id"])
        version = get_document_version(database=self.database, version_id=result["document_version_id"])
        chunks = list_document_chunks(database=self.database, version_id=version["id"])
        self.assertEqual(asset["canonical_path"], str(self.source_file.resolve()))
        self.assertEqual(version["memory_document_id"], result["memory_document_id"])
        self.assertEqual(len(chunks), result["chunk_count"])
        self.assertEqual(chunks[0]["start_line"], 1)
        self.assertEqual(chunks[-1]["end_line"], preview["manifest"]["line_count"])

    def test_31_existing_source_is_reused(self) -> None:
        content_hash = sha256_file(self.source_file)
        source = add_source(
            "report",
            project_id=self.project["id"],
            canonical_path=str(self.source_file.resolve()),
            content_hash=content_hash,
            source_version="existing",
            database=self.database,
        )
        preview = self.preview()
        self.assertEqual(preview["manifest"]["existing_source_id"], source["id"])
        result = self.commit(preview)
        self.assertTrue(result["source_reused"])
        self.assertEqual(result["source_id"], source["id"])
        self.assertEqual(inspect_database(self.database)["table_counts"]["sources"], 1)

    def test_32_duplicate_commit_creates_no_duplicate_domain_records(self) -> None:
        preview = self.preview()
        first = self.commit(preview)
        before = inspect_database(self.database)["table_counts"]
        second = self.commit(preview)
        after = inspect_database(self.database)["table_counts"]
        self.assertEqual(second["status"], "ALREADY_IMPORTED")
        for table in ("sources", "documents", "document_assets", "document_versions", "document_chunks"):
            self.assertEqual(after[table], before[table])
        self.assertEqual(after["ingest_runs"], before["ingest_runs"] + 1)
        self.assertEqual(first["document_version_id"], second["document_version_id"])

    def test_33_same_path_changed_content_creates_new_version(self) -> None:
        first_preview = self.preview()
        first = self.commit(first_preview)
        self.source_file.write_text(self.source_file.read_text(encoding="utf-8") + "New version\n", encoding="utf-8")
        second_preview = self.preview(source_version="fixture-v2")
        self.assertEqual(second_preview["manifest"]["duplicate_status"], "new_version")
        second = self.commit(second_preview)
        self.assertTrue(second["asset_reused"])
        self.assertEqual(first["asset_id"], second["asset_id"])
        self.assertNotEqual(first["document_version_id"], second["document_version_id"])
        versions = list_document_versions(database=self.database, asset_id=first["asset_id"])
        self.assertEqual(len(versions), 2)
        state = inspect_database(self.database)
        self.assertEqual(state["table_counts"]["sources"], 2)
        self.assertEqual(state["table_counts"]["documents"], 2)

    def test_34_transaction_failure_rolls_back_all_domain_writes(self) -> None:
        preview = self.preview()
        before = inspect_database(self.database)["table_counts"]
        with self.assertRaises(IngestError) as caught:
            self.commit(preview, _failure_point="after_chunks")
        self.assertEqual(caught.exception.code, "INJECTED_TRANSACTION_FAILURE")
        after = inspect_database(self.database)["table_counts"]
        self.assertEqual(after, before)

    def test_35_chunk_query_apis_return_deterministic_matches(self) -> None:
        result = self.commit(self.preview())
        matches = search_document_chunks(
            database=self.database,
            query="Omega marker",
            project_id=self.project["id"],
            asset_id=result["asset_id"],
        )
        self.assertEqual(len(matches), 1)
        self.assertIn("Omega marker", matches[0]["content"])
        self.assertEqual(matches[0]["canonical_path"], str(self.source_file.resolve()))

    def test_36_database_foreign_key_damage_blocks_preview(self) -> None:
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("PRAGMA foreign_keys = OFF")
            connection.execute(
                """
                INSERT INTO sources(project_id, source_type, canonical_path, created_at)
                VALUES (999999, 'file', 'C:/workspace/bad.txt', '2026-08-16T00:00:00Z')
                """
            )
            connection.commit()
        with self.assertRaises(IngestError) as caught:
            self.preview()
        self.assertEqual(caught.exception.code, "DATABASE_INTEGRITY_FAILED")

    def test_37_canonical_databases_are_current_and_production_is_empty(self) -> None:
        production = inspect_database(PRODUCTION_DATABASE)
        test = inspect_database(CANONICAL_TEST_DATABASE)
        self.assertEqual(production["user_version"], 4)
        self.assertEqual(test["user_version"], 4)
        for table in (
            "projects", "decisions", "experiments", "documents", "tasks", "sessions",
            "sources", "record_sources", "document_assets", "document_versions",
            "document_chunks", "ingest_runs",
        ):
            self.assertEqual(production["table_counts"][table], 0)
        self.assertEqual(test["table_counts"]["projects"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
