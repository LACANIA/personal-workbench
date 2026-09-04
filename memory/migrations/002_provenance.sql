CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE sources (
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

CREATE TABLE record_sources (
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

CREATE INDEX idx_sources_project_type
    ON sources(project_id, source_type);

CREATE INDEX idx_record_sources_entity
    ON record_sources(entity_type, entity_id);

CREATE INDEX idx_record_sources_source
    ON record_sources(source_id);

CREATE UNIQUE INDEX idx_record_sources_unique_link
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

