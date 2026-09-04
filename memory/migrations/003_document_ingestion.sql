CREATE TABLE document_assets (
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

CREATE TABLE document_versions (
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

CREATE TABLE document_chunks (
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

CREATE TABLE ingest_runs (
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

CREATE INDEX idx_document_assets_project
    ON document_assets(project_id, id);

CREATE INDEX idx_document_versions_asset_created
    ON document_versions(asset_id, created_at);

CREATE INDEX idx_document_versions_source
    ON document_versions(source_id);

CREATE INDEX idx_document_chunks_version_lines
    ON document_chunks(document_version_id, start_line, end_line);

CREATE INDEX idx_ingest_runs_project_path
    ON ingest_runs(project_id, canonical_path COLLATE NOCASE, started_at);
