"""Transactional, manifest-backed Research Memory schema migrations."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MY_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(MY_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(MY_AGENT_ROOT))

from memory.database.init_db import MEMORY_ROOT, resolve_database_path  # noqa: E402
from memory.database.validate_db import inspect_database, sha256_file  # noqa: E402
from memory.database.verify_backup import verify_backup  # noqa: E402


DEFAULT_MANIFEST_PATH = MEMORY_ROOT / "migrations" / "migration_manifest.json"
BUSINESS_TABLES = ("projects", "decisions", "experiments", "documents", "tasks", "sessions")
PROTECTED_TABLES = BUSINESS_TABLES + (
    "sources",
    "record_sources",
    "document_assets",
    "document_versions",
    "document_chunks",
    "ingest_runs",
)


class MigrationError(RuntimeError):
    """Raised when a migration precondition or transaction fails."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load_migration_manifest(manifest_path: str | Path = DEFAULT_MANIFEST_PATH) -> dict[str, Any]:
    """Load and validate the migration manifest and all referenced SQL checksums."""
    path = Path(manifest_path).resolve(strict=True)
    migrations_root = (MEMORY_ROOT / "migrations").resolve(strict=True)
    try:
        path.relative_to(MEMORY_ROOT.resolve(strict=True))
    except ValueError as exc:
        raise MigrationError(f"migration manifest must stay inside {MEMORY_ROOT}: {path}") from exc
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("manifest_version") != 1:
        raise MigrationError("unsupported migration manifest version")
    migrations = payload.get("migrations")
    if not isinstance(migrations, list) or not migrations:
        raise MigrationError("migration manifest must contain at least one migration")

    previous_version = 1
    normalized = []
    for entry in migrations:
        version = entry.get("version")
        name = entry.get("name")
        file_name = entry.get("file")
        checksum = entry.get("sha256")
        if not isinstance(version, int) or version != previous_version + 1:
            raise MigrationError("migration versions must be contiguous and start after version 1")
        if not isinstance(name, str) or not name.strip():
            raise MigrationError(f"migration {version} has an invalid name")
        if not isinstance(file_name, str) or not file_name.strip():
            raise MigrationError(f"migration {version} has an invalid SQL file")
        if not isinstance(checksum, str) or len(checksum) != 64:
            raise MigrationError(f"migration {version} has an invalid SHA-256")
        sql_path = (path.parent / file_name).resolve(strict=True)
        try:
            sql_path.relative_to(migrations_root)
        except ValueError as exc:
            raise MigrationError(f"migration SQL must stay inside {migrations_root}: {sql_path}") from exc
        sql_bytes = sql_path.read_bytes()
        actual_checksum = _sha256_bytes(sql_bytes)
        if actual_checksum != checksum.lower():
            raise MigrationError(
                f"migration {version} checksum mismatch: expected {checksum}, found {actual_checksum}"
            )
        normalized.append(
            {
                "version": version,
                "name": name.strip(),
                "sql_path": sql_path,
                "checksum": actual_checksum,
                "sql": sql_bytes.decode("utf-8"),
            }
        )
        previous_version = version

    if payload.get("latest_schema_version") != previous_version:
        raise MigrationError("latest_schema_version does not match the migration list")
    return {
        "manifest_path": path,
        "latest_schema_version": previous_version,
        "migrations": normalized,
    }


def _split_sql_statements(sql: str) -> list[str]:
    statements: list[str] = []
    buffer = ""
    for line in sql.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statement = buffer.strip()
            if statement:
                statements.append(statement)
            buffer = ""
    if buffer.strip():
        raise MigrationError("migration SQL ends with an incomplete statement")
    return statements


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
        ).fetchone()
        is not None
    )


def _protected_counts(connection: sqlite3.Connection) -> dict[str, int]:
    """Count every durable data table that predates the pending migration."""
    return {
        table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in PROTECTED_TABLES
        if _table_exists(connection, table)
    }


def _verify_applied_migrations(
    connection: sqlite3.Connection, manifest: dict[str, Any], current_version: int
) -> list[dict[str, Any]]:
    table_exists = (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
        ).fetchone()
        is not None
    )
    if current_version >= 2 and not table_exists:
        raise MigrationError("schema_migrations is missing from a version 2 or later database")
    if not table_exists:
        return []

    rows = [
        dict(row)
        for row in connection.execute(
            "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version"
        )
    ]
    by_version = {row["version"]: row for row in rows}
    for migration in manifest["migrations"]:
        if migration["version"] > current_version:
            continue
        row = by_version.get(migration["version"])
        if row is None:
            raise MigrationError(
                f"schema_migrations lacks applied version {migration['version']}"
            )
        if row["name"] != migration["name"] or row["checksum"] != migration["checksum"]:
            raise MigrationError(
                f"applied migration {migration['version']} differs from the current manifest"
            )
    return rows


def _validate_required_backup(database_path: Path, backup_manifest: str | Path) -> dict[str, Any]:
    manifest_path = Path(backup_manifest).resolve(strict=True)
    verification = verify_backup(manifest_path)
    manifest_payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_path = Path(manifest_payload["source_database"]).resolve(strict=True)
    if source_path != database_path:
        raise MigrationError(
            f"backup source {source_path} does not match migration target {database_path}"
        )
    current_sha = sha256_file(database_path)
    if manifest_payload["database_sha256"] != current_sha:
        raise MigrationError("migration target changed after the required backup was created")
    return verification


def migrate_database(
    database_path: str | Path,
    *,
    backup_manifest: str | Path | None = None,
    manifest_path: str | Path = DEFAULT_MANIFEST_PATH,
) -> dict[str, Any]:
    """Migrate one known database version in a single transaction."""
    target_path = resolve_database_path(database_path)
    if not target_path.is_file():
        raise FileNotFoundError(f"database not found: {target_path}")
    manifest = load_migration_manifest(manifest_path)
    before = inspect_database(target_path)
    current_version = before["user_version"]
    latest_version = manifest["latest_schema_version"]
    if current_version < 1:
        raise MigrationError(f"unsupported database schema version: {current_version}")
    if current_version > latest_version:
        raise MigrationError(
            f"database version {current_version} is newer than manifest version {latest_version}"
        )

    connection = sqlite3.connect(target_path, timeout=5.0, isolation_level=None)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        applied_before = _verify_applied_migrations(connection, manifest, current_version)
        if current_version == latest_version:
            return {
                "database_path": str(target_path),
                "from_version": current_version,
                "to_version": current_version,
                "applied": [],
                "already_current": True,
                "schema_migrations": applied_before,
                "integrity_check": before["integrity_check"],
                "foreign_key_check": before["foreign_key_check"],
                "business_counts": {
                    table: before["table_counts"][table] for table in BUSINESS_TABLES
                },
                "protected_counts": {
                    table: before["table_counts"][table]
                    for table in PROTECTED_TABLES
                    if table in before["table_counts"]
                },
            }
        if backup_manifest is None:
            raise MigrationError("an applicable, verified backup manifest is required before migration")
        backup_verification = _validate_required_backup(target_path, backup_manifest)

        before_counts = _protected_counts(connection)
        pending = [
            migration
            for migration in manifest["migrations"]
            if migration["version"] > current_version
        ]
        connection.execute("BEGIN IMMEDIATE")
        applied: list[dict[str, Any]] = []
        try:
            expected_version = current_version
            for migration in pending:
                if migration["version"] != expected_version + 1:
                    raise MigrationError("pending migration sequence is not contiguous")
                for statement in _split_sql_statements(migration["sql"]):
                    connection.execute(statement)
                applied_at = _utc_now()
                connection.execute(
                    """
                    INSERT INTO schema_migrations(version, name, checksum, applied_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        migration["version"],
                        migration["name"],
                        migration["checksum"],
                        applied_at,
                    ),
                )
                connection.execute(f"PRAGMA user_version = {migration['version']}")
                applied.append(
                    {
                        "version": migration["version"],
                        "name": migration["name"],
                        "checksum": migration["checksum"],
                        "applied_at": applied_at,
                    }
                )
                expected_version = migration["version"]

            after_counts = {
                table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in before_counts
            }
            if after_counts != before_counts:
                raise MigrationError("protected table counts changed during migration")
            integrity_rows = [row[0] for row in connection.execute("PRAGMA integrity_check")]
            foreign_key_rows = [list(row) for row in connection.execute("PRAGMA foreign_key_check")]
            if integrity_rows != ["ok"] or foreign_key_rows:
                raise MigrationError("post-migration integrity or foreign-key validation failed")
            connection.execute("COMMIT")
        except Exception:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
    except sqlite3.Error as exc:
        raise MigrationError(f"SQLite migration failed: {exc}") from exc
    finally:
        connection.close()

    after = inspect_database(target_path)
    return {
        "database_path": str(target_path),
        "from_version": current_version,
        "to_version": after["user_version"],
        "applied": applied,
        "already_current": False,
        "backup_verification": backup_verification,
        "integrity_check": after["integrity_check"],
        "foreign_key_check": after["foreign_key_check"],
        "business_counts": {table: after["table_counts"][table] for table in BUSINESS_TABLES},
        "protected_counts": {
            table: after["table_counts"][table]
            for table in PROTECTED_TABLES
            if table in after["table_counts"]
        },
        "schema_migrations": after["schema_migrations"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate a Research Memory database.")
    parser.add_argument("database", type=Path)
    parser.add_argument("--backup-manifest", type=Path)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST_PATH)
    args = parser.parse_args()
    result = migrate_database(
        args.database,
        backup_manifest=args.backup_manifest,
        manifest_path=args.manifest,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
