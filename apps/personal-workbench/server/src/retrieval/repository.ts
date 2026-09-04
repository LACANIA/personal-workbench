import { createHash, randomUUID } from 'node:crypto'
import type { EmbeddingRecord, KnowledgeCardRecord, RetrievalBenchmarkSummary } from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'

export type EmbeddingEntityType = EmbeddingRecord['entity_type']
export type EmbeddingIndexState = EmbeddingRecord['index_state']

export interface IndexableEntity {
  entity_type: EmbeddingEntityType
  entity_id: string
  text: string
  content_sha256: string
  project_id: string
  video_document_id: string
  segment_id: string
  knowledge_point_id: string | null
  knowledge_card_id: string | null
  title: string
  start_ms: number
  end_ms: number
  transcript_source: string
  memory_state: 'staged' | 'approved' | 'published'
  index_state: EmbeddingIndexState
  knowledge_artifact_id: string | null
  artifact_name: string | null
  structured_card: Pick<KnowledgeCardRecord, 'title' | 'concept' | 'core_claim' | 'explanation' | 'keywords' | 'status' | 'validation_status' | 'duplicate_status'> | null
}

export interface StoredEmbedding extends EmbeddingRecord {
  vector: number[]
  entity: IndexableEntity
}

function textHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function vectorToBlob(vector: number[]): Buffer {
  if (!Array.isArray(vector) || vector.length === 0 || vector.length > 4096 || !vector.every(value => Number.isFinite(value))) {
    throw new Error('INVALID_EMBEDDING_VECTOR')
  }
  const buffer = Buffer.allocUnsafe(vector.length * 4)
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4))
  return buffer
}

export function blobToVector(value: unknown, dimension: number): number[] {
  const buffer = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : null
  if (buffer === null || buffer.length !== dimension * 4) throw new Error('EMBEDDING_VECTOR_BLOB_INVALID')
  return Array.from({ length: dimension }, (_, index) => buffer.readFloatLE(index * 4))
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : []
  } catch { return [] }
}

function indexState(memoryState: string): EmbeddingIndexState {
  return memoryState === 'approved' || memoryState === 'published' ? 'approved' : 'staged'
}

export class EmbeddingRecordRepository {
  constructor(readonly database: WorkbenchDatabase) {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_records (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('video_segment','knowledge_point','knowledge_card')),
        entity_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('ollama','local-hash-v1')),
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL CHECK(dimension BETWEEN 1 AND 4096),
        content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
        vector_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
        index_state TEXT NOT NULL CHECK(index_state IN ('staged','approved')),
        UNIQUE(entity_type, entity_id, provider, model, content_sha256)
      );
      CREATE TABLE IF NOT EXISTS retrieval_benchmark_runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        semantic_model TEXT NOT NULL,
        selected_default TEXT NOT NULL CHECK(selected_default IN ('semantic','local-hash-v1')),
        result_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS retrieval_benchmark_runs_created
        ON retrieval_benchmark_runs(created_at DESC, id DESC);
    `)
    this.ensureKnowledgeCardEntityType()
    this.database.db.exec(`
      CREATE INDEX IF NOT EXISTS embedding_records_lookup
        ON embedding_records(provider, model, entity_type, is_active, index_state);
      CREATE INDEX IF NOT EXISTS embedding_records_entity
        ON embedding_records(entity_type, entity_id, created_at DESC);
    `)
  }

  private ensureKnowledgeCardEntityType(): void {
    const definition = this.database.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='embedding_records'")
      .get() as { sql?: string } | undefined
    if (definition?.sql?.includes("'knowledge_card'")) return
    if (definition?.sql === undefined) throw new Error('EMBEDDING_SCHEMA_NOT_FOUND')
    this.database.db.exec('BEGIN IMMEDIATE')
    try {
      this.database.db.exec(`
        DROP INDEX IF EXISTS embedding_records_lookup;
        DROP INDEX IF EXISTS embedding_records_entity;
        ALTER TABLE embedding_records RENAME TO embedding_records_step31_legacy;
        CREATE TABLE embedding_records (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL CHECK(entity_type IN ('video_segment','knowledge_point','knowledge_card')),
          entity_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('ollama','local-hash-v1')),
          model TEXT NOT NULL,
          dimension INTEGER NOT NULL CHECK(dimension BETWEEN 1 AND 4096),
          content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
          vector_blob BLOB NOT NULL,
          created_at TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
          index_state TEXT NOT NULL CHECK(index_state IN ('staged','approved')),
          UNIQUE(entity_type, entity_id, provider, model, content_sha256)
        );
        INSERT INTO embedding_records SELECT * FROM embedding_records_step31_legacy;
        DROP TABLE embedding_records_step31_legacy;
        CREATE INDEX embedding_records_lookup
          ON embedding_records(provider, model, entity_type, is_active, index_state);
        CREATE INDEX embedding_records_entity
          ON embedding_records(entity_type, entity_id, created_at DESC);
      `)
      this.database.db.exec('COMMIT')
    } catch (error) {
      this.database.db.exec('ROLLBACK')
      throw error
    }
  }

  upsert(input: {
    entity_type: EmbeddingEntityType
    entity_id: string
    provider: EmbeddingRecord['provider']
    model: string
    vector: number[]
    content_sha256: string
    index_state: EmbeddingIndexState
  }): EmbeddingRecord {
    const entity = this.getIndexableEntity(input.entity_type, input.entity_id)
    if (entity === undefined) throw new Error('EMBEDDING_ENTITY_NOT_FOUND')
    if (entity.content_sha256 !== input.content_sha256) throw new Error('EMBEDDING_CONTENT_HASH_MISMATCH')
    const blob = vectorToBlob(input.vector)
    const timestamp = new Date().toISOString()
    this.database.db.exec('BEGIN IMMEDIATE')
    try {
      this.database.db.prepare(`
        UPDATE embedding_records SET is_active=0
        WHERE entity_type=? AND entity_id=? AND provider=? AND model=? AND content_sha256<>? AND is_active=1
      `).run(input.entity_type, input.entity_id, input.provider, input.model, input.content_sha256)
      this.database.db.prepare(`
        INSERT INTO embedding_records(
          id, entity_type, entity_id, provider, model, dimension, content_sha256,
          vector_blob, created_at, is_active, index_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(entity_type, entity_id, provider, model, content_sha256)
        DO UPDATE SET vector_blob=excluded.vector_blob, dimension=excluded.dimension,
          is_active=1, index_state=excluded.index_state
      `).run(randomUUID(), input.entity_type, input.entity_id, input.provider, input.model,
        input.vector.length, input.content_sha256, blob, timestamp, input.index_state)
      this.database.db.exec('COMMIT')
    } catch (error) {
      this.database.db.exec('ROLLBACK')
      throw error
    }
    return this.getActive(input.entity_type, input.entity_id, input.provider, input.model)!
  }

  getActive(entityType: EmbeddingEntityType, entityId: string, provider: EmbeddingRecord['provider'], model: string): EmbeddingRecord | undefined {
    const row = this.database.db.prepare(`
      SELECT id, entity_type, entity_id, provider, model, dimension, content_sha256,
        length(vector_blob) AS vector_bytes, created_at, is_active, index_state
      FROM embedding_records
      WHERE entity_type=? AND entity_id=? AND provider=? AND model=? AND is_active=1
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(entityType, entityId, provider, model) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapRecord(row)
  }

  listStored(input: {
    provider: EmbeddingRecord['provider']
    model: string
    project_id?: string
    entity_type?: EmbeddingEntityType
    include_staged?: boolean
  }): StoredEmbedding[] {
    const entities = this.listIndexableEntities(input.project_id, input.entity_type)
      .filter(entity => input.include_staged !== false || entity.index_state === 'approved')
    const statement = this.database.db.prepare(`
      SELECT id, entity_type, entity_id, provider, model, dimension, content_sha256,
        vector_blob, length(vector_blob) AS vector_bytes, created_at, is_active, index_state
      FROM embedding_records
      WHERE entity_type=? AND entity_id=? AND provider=? AND model=? AND is_active=1
      ORDER BY created_at DESC, id DESC LIMIT 1
    `)
    const stored: StoredEmbedding[] = []
    for (const entity of entities) {
      const row = statement.get(entity.entity_type, entity.entity_id, input.provider, input.model) as Record<string, unknown> | undefined
      if (row === undefined || String(row.content_sha256) !== entity.content_sha256) continue
      const record = this.mapRecord(row)
      stored.push({ ...record, vector: blobToVector(row.vector_blob, record.dimension), entity })
    }
    return stored
  }

  listIndexableEntities(projectId?: string, entityType?: EmbeddingEntityType): IndexableEntity[] {
    const values: string[] = []
    const projectFilter = projectId === undefined ? '' : ' AND d.project_id = ?'
    if (projectId !== undefined) values.push(projectId)
    const parts: string[] = []
    if (entityType === undefined || entityType === 'video_segment') {
      parts.push(`
        SELECT 'video_segment' AS entity_type, s.id AS entity_id, s.text AS content,
          s.text_hash AS content_sha256, d.project_id, d.id AS video_document_id,
          s.id AS segment_id, NULL AS knowledge_point_id, NULL AS knowledge_card_id,
          d.title, s.start_ms, s.end_ms, d.metadata_json, d.memory_state,
          d.knowledge_artifact_id, a.name AS artifact_name,
          NULL AS card_title, NULL AS concept, NULL AS core_claim, NULL AS explanation,
          NULL AS keywords_json, NULL AS validation_status, NULL AS duplicate_status
        FROM video_segments s
        JOIN video_documents d ON d.id=s.video_document_id
        LEFT JOIN artifacts a ON a.id=d.knowledge_artifact_id
        WHERE 1=1${projectFilter}
      `)
    }
    if (entityType === undefined || entityType === 'knowledge_point') {
      parts.push(`
        SELECT 'knowledge_point' AS entity_type, p.id AS entity_id, p.summary AS content,
          '' AS content_sha256, d.project_id, d.id AS video_document_id,
          s.id AS segment_id, p.id AS knowledge_point_id, NULL AS knowledge_card_id,
          d.title, s.start_ms, s.end_ms, d.metadata_json, p.memory_state,
          d.knowledge_artifact_id, a.name AS artifact_name,
          NULL AS card_title, NULL AS concept, NULL AS core_claim, NULL AS explanation,
          NULL AS keywords_json, NULL AS validation_status, NULL AS duplicate_status
        FROM video_knowledge_points p
        JOIN video_segments s ON s.id=p.segment_id
        JOIN video_documents d ON d.id=p.video_document_id
        LEFT JOIN artifacts a ON a.id=d.knowledge_artifact_id
        WHERE 1=1${projectFilter}
      `)
    }
    if (entityType === undefined || entityType === 'knowledge_card') {
      parts.push(`
        SELECT 'knowledge_card' AS entity_type, c.id AS entity_id, '' AS content,
          '' AS content_sha256, d.project_id, d.id AS video_document_id,
          s.id AS segment_id, NULL AS knowledge_point_id, c.id AS knowledge_card_id,
          d.title, s.start_ms, s.end_ms, d.metadata_json, c.status AS memory_state,
          c.artifact_id AS knowledge_artifact_id, a.name AS artifact_name,
          c.title AS card_title, c.concept, c.core_claim, c.explanation,
          c.keywords_json, c.validation_status, c.duplicate_status
        FROM knowledge_cards c
        JOIN video_segments s ON s.id=c.segment_id
        JOIN video_documents d ON d.id=c.video_document_id
        LEFT JOIN artifacts a ON a.id=c.artifact_id
        WHERE c.status IN ('staged','approved') AND c.source_state='current'${projectFilter}
      `)
    }
    if (parts.length === 0) return []
    const sql = parts.join(' UNION ALL ')
    const repeatedValues = projectId === undefined ? [] : parts.flatMap(() => values)
    const rows = this.database.db.prepare(`${sql} ORDER BY video_document_id, start_ms, entity_type, entity_id`).all(...repeatedValues) as Record<string, unknown>[]
    return rows.map(row => {
      const card = row.entity_type === 'knowledge_card' ? {
        title: String(row.card_title), concept: String(row.concept), core_claim: String(row.core_claim),
        explanation: String(row.explanation), keywords: parseStringArray(row.keywords_json),
        status: row.memory_state as KnowledgeCardRecord['status'], validation_status: row.validation_status as KnowledgeCardRecord['validation_status'],
        duplicate_status: row.duplicate_status as KnowledgeCardRecord['duplicate_status'],
      } : null
      const content = card === null ? String(row.content) : [card.title, card.concept, card.core_claim, card.explanation, card.keywords.join(', ')].join('\n')
      const metadata = parseMetadata(row.metadata_json)
      const memoryState = String(row.memory_state)
      return {
        entity_type: row.entity_type as EmbeddingEntityType,
        entity_id: String(row.entity_id),
        text: content,
        content_sha256: String(row.content_sha256).length === 64 ? String(row.content_sha256) : textHash(content),
        project_id: String(row.project_id),
        video_document_id: String(row.video_document_id),
        segment_id: String(row.segment_id),
        knowledge_point_id: row.knowledge_point_id === null ? null : String(row.knowledge_point_id),
        knowledge_card_id: row.knowledge_card_id === null ? null : String(row.knowledge_card_id),
        title: String(row.title), start_ms: Number(row.start_ms), end_ms: Number(row.end_ms),
        transcript_source: String(metadata.transcript_source ?? 'unknown'),
        memory_state: memoryState as IndexableEntity['memory_state'], index_state: indexState(memoryState),
        knowledge_artifact_id: row.knowledge_artifact_id === null ? null : String(row.knowledge_artifact_id),
        artifact_name: row.artifact_name === null ? null : String(row.artifact_name),
        structured_card: card,
      }
    })
  }

  getIndexableEntity(entityType: EmbeddingEntityType, entityId: string): IndexableEntity | undefined {
    return this.listIndexableEntities(undefined, entityType).find(entity => entity.entity_id === entityId)
  }

  markDocumentApproved(documentId: string): number {
    return Number(this.database.db.prepare(`
      UPDATE embedding_records SET index_state='approved'
      WHERE (entity_type='video_segment' AND entity_id IN (SELECT id FROM video_segments WHERE video_document_id=?))
         OR (entity_type='knowledge_point' AND entity_id IN (SELECT id FROM video_knowledge_points WHERE video_document_id=?))
    `).run(documentId, documentId).changes)
  }

  markCardApproved(cardId: string): number {
    return Number(this.database.db.prepare(`
      UPDATE embedding_records SET index_state='approved'
      WHERE entity_type='knowledge_card' AND entity_id=? AND is_active=1
    `).run(cardId).changes)
  }

  diagnostics(): { total: number; video_segments: number; knowledge_points: number; knowledge_cards: number; staged: number; approved: number; stale: number; bytes: number } {
    const row = this.database.db.prepare(`
      SELECT SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) AS total,
        COUNT(DISTINCT CASE WHEN entity_type='video_segment' AND is_active=1 THEN entity_id END) AS video_segments,
        COUNT(DISTINCT CASE WHEN entity_type='knowledge_point' AND is_active=1 THEN entity_id END) AS knowledge_points,
        COUNT(DISTINCT CASE WHEN entity_type='knowledge_card' AND is_active=1 THEN entity_id END) AS knowledge_cards,
        COUNT(DISTINCT CASE WHEN index_state='staged' AND is_active=1 THEN entity_type || char(31) || entity_id END) AS staged,
        COUNT(DISTINCT CASE WHEN index_state='approved' AND is_active=1 THEN entity_type || char(31) || entity_id END) AS approved,
        SUM(CASE WHEN is_active=0 THEN 1 ELSE 0 END) AS stale,
        SUM(length(vector_blob)) AS bytes
      FROM embedding_records
    `).get() as Record<string, unknown>
    return {
      total: Number(row.total ?? 0), video_segments: Number(row.video_segments ?? 0), knowledge_points: Number(row.knowledge_points ?? 0),
      knowledge_cards: Number(row.knowledge_cards ?? 0),
      staged: Number(row.staged ?? 0), approved: Number(row.approved ?? 0), stale: Number(row.stale ?? 0), bytes: Number(row.bytes ?? 0),
    }
  }

  saveBenchmark(summary: RetrievalBenchmarkSummary): void {
    this.database.db.prepare(`
      INSERT INTO retrieval_benchmark_runs(id, created_at, semantic_model, selected_default, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), summary.created_at, summary.semantic_model, summary.selected_default, JSON.stringify(summary))
  }

  latestBenchmark(): RetrievalBenchmarkSummary | null {
    const row = this.database.db.prepare(`
      SELECT result_json FROM retrieval_benchmark_runs ORDER BY created_at DESC, id DESC LIMIT 1
    `).get() as { result_json?: string } | undefined
    if (row?.result_json === undefined) return null
    try { return JSON.parse(row.result_json) as RetrievalBenchmarkSummary } catch { return null }
  }

  private mapRecord(row: Record<string, unknown>): EmbeddingRecord {
    return {
      id: String(row.id), entity_type: row.entity_type as EmbeddingEntityType, entity_id: String(row.entity_id),
      provider: row.provider as EmbeddingRecord['provider'], model: String(row.model), dimension: Number(row.dimension),
      content_sha256: String(row.content_sha256), vector_bytes: Number(row.vector_bytes), created_at: String(row.created_at),
      is_active: Number(row.is_active) === 1, index_state: row.index_state as EmbeddingIndexState,
    }
  }
}
