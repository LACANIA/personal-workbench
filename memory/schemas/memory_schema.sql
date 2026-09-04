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

CREATE TABLE IF NOT EXISTS document_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    canonical_path TEXT NOT NULL COLLATE NOCASE,
    document_type TEXT NOT NULL CHECK (length(trim(document_type)) > 0),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    UNIQUE (project_id, canonical_path COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS document_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    memory_document_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    normalized_text_hash TEXT NOT NULL CHECK (length(normalized_text_hash) = 64),
    source_version TEXT NOT NULL CHECK (length(trim(source_version)) > 0),
    parser_name TEXT NOT NULL CHECK (length(trim(parser_name)) > 0),
    parser_version TEXT NOT NULL CHECK (length(trim(parser_version)) > 0),
    chunker_name TEXT NOT NULL CHECK (length(trim(chunker_name)) > 0),
    chunker_version TEXT NOT NULL CHECK (length(trim(chunker_version)) > 0),
    chunking_config_json TEXT NOT NULL CHECK (json_valid(chunking_config_json)),
    text_encoding TEXT NOT NULL CHECK (text_encoding IN ('utf-8', 'utf-8-sig')),
    byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
    line_count INTEGER NOT NULL CHECK (line_count >= 1),
    chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1),
    created_at TEXT NOT NULL,
    FOREIGN KEY (asset_id) REFERENCES document_assets(id) ON DELETE RESTRICT,
    FOREIGN KEY (memory_document_id) REFERENCES documents(id) ON DELETE RESTRICT,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT,
    UNIQUE (asset_id, content_hash)
);

CREATE TABLE IF NOT EXISTS document_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_version_id INTEGER NOT NULL,
    chunk_uid TEXT NOT NULL UNIQUE CHECK (length(chunk_uid) = 64),
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    heading_path_json TEXT NOT NULL CHECK (json_valid(heading_path_json)),
    start_line INTEGER NOT NULL CHECK (start_line >= 1),
    end_line INTEGER NOT NULL CHECK (end_line >= start_line),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL CHECK (char_count >= 0),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (document_version_id) REFERENCES document_versions(id) ON DELETE RESTRICT,
    UNIQUE (document_version_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS ingest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    canonical_path TEXT NOT NULL COLLATE NOCASE,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    manifest_path TEXT NOT NULL,
    manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
    mode TEXT NOT NULL CHECK (mode = 'commit'),
    status TEXT NOT NULL CHECK (status IN ('committed', 'already_imported', 'failed')),
    asset_id INTEGER,
    document_version_id INTEGER,
    backup_manifest_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    error_message TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    FOREIGN KEY (asset_id) REFERENCES document_assets(id) ON DELETE RESTRICT,
    FOREIGN KEY (document_version_id) REFERENCES document_versions(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_document_assets_project
    ON document_assets(project_id, id);

CREATE INDEX IF NOT EXISTS idx_document_versions_asset_created
    ON document_versions(asset_id, created_at);

CREATE INDEX IF NOT EXISTS idx_document_versions_source
    ON document_versions(source_id);

CREATE INDEX IF NOT EXISTS idx_document_chunks_version_lines
    ON document_chunks(document_version_id, start_line, end_line);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_project_path
    ON ingest_runs(project_id, canonical_path COLLATE NOCASE, started_at);

CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
    content,
    heading_path_json,
    content = 'document_chunks',
    content_rowid = 'id',
    tokenize = 'trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts_vocab USING fts5vocab(
    document_chunks_fts,
    'instance'
);

CREATE TABLE IF NOT EXISTS document_chunk_fts_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    index_name TEXT NOT NULL UNIQUE CHECK (index_name = 'document_chunks_fts'),
    tokenizer TEXT NOT NULL CHECK (length(trim(tokenizer)) > 0),
    built_at TEXT NOT NULL,
    validated_at TEXT NOT NULL,
    source_chunk_count INTEGER NOT NULL CHECK (source_chunk_count >= 0),
    indexed_row_count INTEGER NOT NULL CHECK (indexed_row_count >= 0),
    source_signature TEXT NOT NULL CHECK (length(source_signature) = 64),
    index_signature TEXT NOT NULL CHECK (length(index_signature) = 64),
    schema_version INTEGER NOT NULL CHECK (schema_version = 4),
    status TEXT NOT NULL CHECK (status IN ('valid', 'stale', 'error'))
);

CREATE TRIGGER IF NOT EXISTS document_chunks_fts_after_insert
AFTER INSERT ON document_chunks
BEGIN
    INSERT INTO document_chunks_fts(rowid, content, heading_path_json)
    VALUES (new.id, new.content, new.heading_path_json);
    UPDATE document_chunk_fts_state SET status = 'stale' WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS document_chunks_fts_after_delete
AFTER DELETE ON document_chunks
BEGIN
    INSERT INTO document_chunks_fts(document_chunks_fts, rowid, content, heading_path_json)
    VALUES ('delete', old.id, old.content, old.heading_path_json);
    UPDATE document_chunk_fts_state SET status = 'stale' WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS document_chunks_fts_after_update
AFTER UPDATE ON document_chunks
BEGIN
    INSERT INTO document_chunks_fts(document_chunks_fts, rowid, content, heading_path_json)
    VALUES ('delete', old.id, old.content, old.heading_path_json);
    INSERT INTO document_chunks_fts(rowid, content, heading_path_json)
    VALUES (new.id, new.content, new.heading_path_json);
    UPDATE document_chunk_fts_state SET status = 'stale' WHERE id = 1;
END;

PRAGMA user_version = 4;
