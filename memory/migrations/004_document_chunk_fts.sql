CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
    content,
    heading_path_json,
    content = 'document_chunks',
    content_rowid = 'id',
    tokenize = 'trigram'
);

CREATE VIRTUAL TABLE document_chunks_fts_vocab USING fts5vocab(
    document_chunks_fts,
    'instance'
);

CREATE TABLE document_chunk_fts_state (
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

CREATE TRIGGER document_chunks_fts_after_insert
AFTER INSERT ON document_chunks
BEGIN
    INSERT INTO document_chunks_fts(rowid, content, heading_path_json)
    VALUES (new.id, new.content, new.heading_path_json);
    UPDATE document_chunk_fts_state SET status = 'stale' WHERE id = 1;
END;

CREATE TRIGGER document_chunks_fts_after_delete
AFTER DELETE ON document_chunks
BEGIN
    INSERT INTO document_chunks_fts(document_chunks_fts, rowid, content, heading_path_json)
    VALUES ('delete', old.id, old.content, old.heading_path_json);
    UPDATE document_chunk_fts_state SET status = 'stale' WHERE id = 1;
END;

CREATE TRIGGER document_chunks_fts_after_update
AFTER UPDATE ON document_chunks
BEGIN
    INSERT INTO document_chunks_fts(document_chunks_fts, rowid, content, heading_path_json)
    VALUES ('delete', old.id, old.content, old.heading_path_json);
    INSERT INTO document_chunks_fts(rowid, content, heading_path_json)
    VALUES (new.id, new.content, new.heading_path_json);
    UPDATE document_chunk_fts_state SET status = 'stale' WHERE id = 1;
END;

INSERT INTO document_chunks_fts(document_chunks_fts) VALUES ('rebuild');
