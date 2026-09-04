PRAGMA foreign_keys = ON;
PRAGMA encoding = 'UTF-8';

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    root_path TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    confidence TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    result TEXT NOT NULL,
    metric TEXT NOT NULL,
    artifact_path TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    UNIQUE (project_id, path, hash)
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    tools TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    source_type TEXT NOT NULL CHECK (length(trim(source_type)) > 0),
    canonical_path TEXT,
    external_ref TEXT,
    content_hash TEXT,
    source_version TEXT,
    created_at TEXT NOT NULL,
    verified_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    CHECK (
        NULLIF(trim(canonical_path), '') IS NOT NULL
        OR NULLIF(trim(external_ref), '') IS NOT NULL
    )
);

CREATE TABLE IF NOT EXISTS record_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK (
        entity_type IN ('project', 'decision', 'experiment', 'document', 'task', 'session')
    ),
    entity_id INTEGER NOT NULL CHECK (entity_id > 0),
    source_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (length(trim(role)) > 0),
    locator_type TEXT NOT NULL CHECK (length(trim(locator_type)) > 0),
    locator_start INTEGER CHECK (locator_start IS NULL OR locator_start > 0),
    locator_end INTEGER CHECK (locator_end IS NULL OR locator_end > 0),
    locator_json TEXT,
    note TEXT,
    verification_status TEXT NOT NULL CHECK (
        verification_status IN ('unverified', 'verified', 'disputed')
    ),
    created_at TEXT NOT NULL,
    verified_at TEXT,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT,
    CHECK (locator_end IS NULL OR locator_start IS NULL OR locator_end >= locator_start)
);

CREATE INDEX IF NOT EXISTS idx_decisions_project_created
    ON decisions(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_experiments_project_created
    ON experiments(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_documents_project_type
    ON documents(project_id, type);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status
    ON tasks(project_id, status);

CREATE INDEX IF NOT EXISTS idx_sessions_task_created
    ON sessions(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sources_project_type
    ON sources(project_id, source_type);

CREATE INDEX IF NOT EXISTS idx_record_sources_entity
    ON record_sources(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_record_sources_source
    ON record_sources(source_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_record_sources_unique_link
    ON record_sources(
        entity_type,
        entity_id,
        source_id,
        role,
        locator_type,
        COALESCE(locator_start, -1),
        COALESCE(locator_end, -1),
        COALESCE(locator_json, '')
    );

PRAGMA user_version = 2;
