import { randomUUID } from 'node:crypto'
import type {
  VideoChapter,
  VideoDocumentRecord,
  VideoInputType,
  VideoJobRecord,
  VideoJobStatus,
  VideoJobView,
  VideoKnowledgeEdgeRecord,
  VideoKnowledgePointRecord,
  VideoMemoryState,
  VideoSegmentRecord,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { KnowledgeCardRepository } from '../knowledge/repository.ts'

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function now(): string { return new Date().toISOString() }

export interface CreateVideoJobRow {
  projectId: string
  taskId: string | null
  inputType: VideoInputType
  inputValue: string
  title: string
  language: string
}

export interface CreateVideoDocumentRow {
  id?: string
  projectId: string
  jobId: string
  title: string
  sourceKind: VideoInputType
  sourceReference: string
  language: string
  durationMs: number
  segmentCount: number
  knowledgePointCount: number
  metadata?: Record<string, unknown>
}

export interface CreateVideoSegmentRow {
  id?: string
  index: number
  startMs: number
  endMs: number
  text: string
  textHash: string
  embeddingProvider: string
  embeddingModel: string
  embedding: number[]
}

export interface CreateKnowledgePointRow {
  id?: string
  segmentId: string
  title: string
  summary: string
  keywords: string[]
  confidence: number
}

export class VideoKnowledgeRepository {
  readonly cards: KnowledgeCardRepository

  constructor(readonly database: WorkbenchDatabase) {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS video_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES workbench_tasks(id) ON DELETE SET NULL,
        input_type TEXT NOT NULL CHECK(input_type IN ('url','local_video','subtitle')),
        input_value TEXT NOT NULL,
        title TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'auto',
        status TEXT NOT NULL CHECK(status IN ('created','inspecting','acquiring','transcribing','segmenting','embedding','packaging','awaiting_review','approved','published','failed','canceled')),
        stage TEXT NOT NULL,
        progress INTEGER NOT NULL CHECK(progress BETWEEN 0 AND 100),
        source_path TEXT,
        subtitle_path TEXT,
        video_document_id TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS video_documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        video_job_id TEXT NOT NULL UNIQUE REFERENCES video_jobs(id) ON DELETE RESTRICT,
        source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        transcript_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        knowledge_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('url','local_video','subtitle')),
        source_reference TEXT NOT NULL,
        language TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
        segment_count INTEGER NOT NULL CHECK(segment_count >= 0),
        knowledge_point_count INTEGER NOT NULL CHECK(knowledge_point_count >= 0),
        memory_state TEXT NOT NULL DEFAULT 'staged' CHECK(memory_state IN ('staged','approved','published')),
        memory_project_name TEXT,
        published_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS video_segments (
        id TEXT PRIMARY KEY,
        video_document_id TEXT NOT NULL REFERENCES video_documents(id) ON DELETE CASCADE,
        segment_index INTEGER NOT NULL CHECK(segment_index >= 0),
        start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK(end_ms >= start_ms),
        text TEXT NOT NULL,
        text_hash TEXT NOT NULL CHECK(length(text_hash) = 64),
        embedding_provider TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        embedding_dimensions INTEGER NOT NULL CHECK(embedding_dimensions > 0),
        embedding_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(video_document_id, segment_index)
      );
      CREATE TABLE IF NOT EXISTS video_knowledge_points (
        id TEXT PRIMARY KEY,
        video_document_id TEXT NOT NULL REFERENCES video_documents(id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL REFERENCES video_segments(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        keywords_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        memory_state TEXT NOT NULL DEFAULT 'staged' CHECK(memory_state IN ('staged','approved','published')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS video_knowledge_edges (
        id TEXT PRIMARY KEY,
        video_document_id TEXT NOT NULL REFERENCES video_documents(id) ON DELETE CASCADE,
        source_knowledge_point_id TEXT NOT NULL REFERENCES video_knowledge_points(id) ON DELETE RESTRICT,
        target_knowledge_point_id TEXT NOT NULL REFERENCES video_knowledge_points(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL CHECK(relation IN ('precedes','related_to','supports')),
        created_at TEXT NOT NULL,
        CHECK(source_knowledge_point_id <> target_knowledge_point_id),
        UNIQUE(source_knowledge_point_id, target_knowledge_point_id, relation)
      );
      CREATE TABLE IF NOT EXISTS video_memory_publications (
        id TEXT PRIMARY KEY,
        video_document_id TEXT NOT NULL REFERENCES video_documents(id) ON DELETE RESTRICT,
        knowledge_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
        memory_role TEXT NOT NULL CHECK(memory_role IN ('production','test')),
        memory_project_name TEXT NOT NULL,
        release_status TEXT NOT NULL,
        published_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(video_document_id, knowledge_artifact_id)
      );
      CREATE INDEX IF NOT EXISTS video_jobs_project_created ON video_jobs(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS video_segments_document_index ON video_segments(video_document_id, segment_index);
      CREATE INDEX IF NOT EXISTS video_points_document_created ON video_knowledge_points(video_document_id, created_at);
      CREATE INDEX IF NOT EXISTS video_publications_document ON video_memory_publications(video_document_id, published_at DESC);
    `)
    this.ensureAudioInputTypes()
    this.cards = new KnowledgeCardRepository(database)
  }

  private ensureAudioInputTypes(): void {
    const jobDefinition = this.database.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='video_jobs'").get() as { sql?: string } | undefined
    const documentDefinition = this.database.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='video_documents'").get() as { sql?: string } | undefined
    if (jobDefinition?.sql?.includes("'audio'") && documentDefinition?.sql?.includes("'audio'")) return
    if (jobDefinition?.sql === undefined || documentDefinition?.sql === undefined) throw new Error('VIDEO_SCHEMA_NOT_FOUND')
    const jobsSql = jobDefinition.sql
      .replace(/CREATE TABLE\s+video_jobs/iu, 'CREATE TABLE video_jobs_step27')
      .replace("('url','local_video','subtitle')", "('url','local_video','subtitle','audio')")
    const documentsSql = documentDefinition.sql
      .replace(/CREATE TABLE\s+video_documents/iu, 'CREATE TABLE video_documents_step27')
      .replace("('url','local_video','subtitle')", "('url','local_video','subtitle','audio')")
    const columnList = (table: string): string => (this.database.db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[])
      .map(column => `"${column.name.replaceAll('"', '""')}"`).join(', ')
    const jobColumns = columnList('video_jobs')
    const documentColumns = columnList('video_documents')
    this.database.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE;')
    try {
      this.database.db.exec(`
        DROP TABLE IF EXISTS video_jobs_step27;
        DROP TABLE IF EXISTS video_documents_step27;
        ${jobsSql};
        ${documentsSql};
        INSERT INTO video_jobs_step27(${jobColumns}) SELECT ${jobColumns} FROM video_jobs;
        INSERT INTO video_documents_step27(${documentColumns}) SELECT ${documentColumns} FROM video_documents;
        DROP TABLE video_documents;
        DROP TABLE video_jobs;
        ALTER TABLE video_jobs_step27 RENAME TO video_jobs;
        ALTER TABLE video_documents_step27 RENAME TO video_documents;
        COMMIT;
      `)
    } catch (error) {
      try { this.database.db.exec('ROLLBACK') } catch { /* transaction may already be closed */ }
      throw error
    } finally {
      this.database.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;')
    }
    this.database.db.exec(`
      CREATE INDEX IF NOT EXISTS video_jobs_project_created ON video_jobs(project_id, created_at DESC);
    `)
    if (this.database.db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('VIDEO_AUDIO_MIGRATION_FOREIGN_KEY_FAILED')
  }

  createJob(input: CreateVideoJobRow): VideoJobRecord {
    const id = randomUUID()
    const timestamp = now()
    this.database.db.prepare(`
      INSERT INTO video_jobs(id, project_id, task_id, input_type, input_value, title, language, status, stage, progress, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'created', 'created', 0, ?, ?)
    `).run(id, input.projectId, input.taskId, input.inputType, input.inputValue, input.title, input.language, timestamp, timestamp)
    return this.getJob(id)!
  }

  getJob(id: string): VideoJobRecord | undefined {
    const row = this.database.db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapJob(row)
  }

  listJobs(projectId?: string, limit = 100): VideoJobRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = projectId === undefined
      ? this.database.db.prepare('SELECT * FROM video_jobs ORDER BY created_at DESC LIMIT ?').all(safeLimit)
      : this.database.db.prepare('SELECT * FROM video_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, safeLimit)
    return (rows as Record<string, unknown>[]).map(row => this.mapJob(row))
  }

  updateJob(id: string, input: {
    status?: VideoJobStatus
    stage?: string
    progress?: number
    sourcePath?: string | null
    subtitlePath?: string | null
    documentId?: string | null
    errorCode?: string | null
    errorMessage?: string | null
    completed?: boolean
    metadata?: Record<string, unknown>
  }): VideoJobRecord {
    const current = this.getJob(id)
    if (current === undefined) throw new Error('VIDEO_JOB_NOT_FOUND')
    const timestamp = now()
    this.database.db.prepare(`
      UPDATE video_jobs SET status=?, stage=?, progress=?, source_path=?, subtitle_path=?, video_document_id=?,
        error_code=?, error_message=?, updated_at=?, completed_at=?, metadata_json=? WHERE id=?
    `).run(
      input.status ?? current.status,
      input.stage ?? current.stage,
      input.progress ?? current.progress,
      input.sourcePath === undefined ? current.source_path : input.sourcePath,
      input.subtitlePath === undefined ? current.subtitle_path : input.subtitlePath,
      input.documentId === undefined ? current.video_document_id : input.documentId,
      input.errorCode === undefined ? current.error_code : input.errorCode,
      input.errorMessage === undefined ? current.error_message : input.errorMessage,
      timestamp,
      input.completed === true ? timestamp : current.completed_at,
      JSON.stringify(input.metadata ?? current.metadata),
      id,
    )
    return this.getJob(id)!
  }

  createDocument(input: CreateVideoDocumentRow): VideoDocumentRecord {
    const id = input.id ?? randomUUID()
    const timestamp = now()
    this.database.db.prepare(`
      INSERT INTO video_documents(
        id, project_id, video_job_id, title, source_kind, source_reference, language, duration_ms,
        segment_count, knowledge_point_count, memory_state, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?)
    `).run(id, input.projectId, input.jobId, input.title, input.sourceKind, input.sourceReference, input.language,
      input.durationMs, input.segmentCount, input.knowledgePointCount, timestamp, timestamp, JSON.stringify(input.metadata ?? {}))
    return this.getDocument(id)!
  }

  getDocument(id: string): VideoDocumentRecord | undefined {
    const row = this.database.db.prepare('SELECT * FROM video_documents WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapDocument(row)
  }

  getDocumentByJob(jobId: string): VideoDocumentRecord | undefined {
    const row = this.database.db.prepare('SELECT * FROM video_documents WHERE video_job_id = ?').get(jobId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapDocument(row)
  }

  listDocuments(projectId?: string, limit = 100): VideoDocumentRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = projectId === undefined
      ? this.database.db.prepare('SELECT * FROM video_documents ORDER BY created_at DESC LIMIT ?').all(safeLimit)
      : this.database.db.prepare('SELECT * FROM video_documents WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, safeLimit)
    return (rows as Record<string, unknown>[]).map(row => this.mapDocument(row))
  }

  insertSegments(documentId: string, segments: CreateVideoSegmentRow[]): VideoSegmentRecord[] {
    const statement = this.database.db.prepare(`
      INSERT INTO video_segments(
        id, video_document_id, segment_index, start_ms, end_ms, text, text_hash,
        embedding_provider, embedding_model, embedding_dimensions, embedding_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const timestamp = now()
    for (const segment of segments) statement.run(segment.id ?? randomUUID(), documentId, segment.index, segment.startMs, segment.endMs,
      segment.text, segment.textHash, segment.embeddingProvider, segment.embeddingModel, segment.embedding.length,
      JSON.stringify(segment.embedding), timestamp)
    return this.listSegments(documentId)
  }

  listSegments(documentId: string): VideoSegmentRecord[] {
    const rows = this.database.db.prepare('SELECT * FROM video_segments WHERE video_document_id = ? ORDER BY segment_index').all(documentId) as Record<string, unknown>[]
    return rows.map(row => this.mapSegment(row))
  }

  insertKnowledgePoints(documentId: string, points: CreateKnowledgePointRow[]): VideoKnowledgePointRecord[] {
    const statement = this.database.db.prepare(`
      INSERT INTO video_knowledge_points(id, video_document_id, segment_id, title, summary, keywords_json, confidence, memory_state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', ?)
    `)
    const timestamp = now()
    for (const point of points) statement.run(point.id ?? randomUUID(), documentId, point.segmentId, point.title, point.summary,
      JSON.stringify(point.keywords), point.confidence, timestamp)
    return this.listKnowledgePoints(documentId)
  }

  insertEdges(documentId: string, points: VideoKnowledgePointRecord[]): VideoKnowledgeEdgeRecord[] {
    const statement = this.database.db.prepare(`
      INSERT OR IGNORE INTO video_knowledge_edges(id, video_document_id, source_knowledge_point_id, target_knowledge_point_id, relation, created_at)
      VALUES (?, ?, ?, ?, 'precedes', ?)
    `)
    const timestamp = now()
    for (let index = 1; index < points.length; index += 1) statement.run(randomUUID(), documentId, points[index - 1]!.id, points[index]!.id, timestamp)
    return this.listEdges(documentId)
  }

  listKnowledgePoints(documentId: string): VideoKnowledgePointRecord[] {
    const rows = this.database.db.prepare('SELECT * FROM video_knowledge_points WHERE video_document_id = ? ORDER BY created_at, id').all(documentId) as Record<string, unknown>[]
    return rows.map(row => this.mapPoint(row))
  }

  listEdges(documentId: string): VideoKnowledgeEdgeRecord[] {
    const rows = this.database.db.prepare('SELECT * FROM video_knowledge_edges WHERE video_document_id = ? ORDER BY created_at, id').all(documentId) as Record<string, unknown>[]
    return rows.map(row => ({
      id: String(row.id), video_document_id: String(row.video_document_id),
      source_knowledge_point_id: String(row.source_knowledge_point_id), target_knowledge_point_id: String(row.target_knowledge_point_id),
      relation: row.relation as VideoKnowledgeEdgeRecord['relation'], created_at: String(row.created_at),
    }))
  }

  attachArtifacts(documentId: string, input: { source?: string | null; transcript?: string | null; knowledge?: string | null }): VideoDocumentRecord {
    const current = this.getDocument(documentId)
    if (current === undefined) throw new Error('VIDEO_DOCUMENT_NOT_FOUND')
    this.database.db.prepare(`
      UPDATE video_documents SET source_artifact_id=?, transcript_artifact_id=?, knowledge_artifact_id=?, updated_at=? WHERE id=?
    `).run(input.source === undefined ? current.source_artifact_id : input.source,
      input.transcript === undefined ? current.transcript_artifact_id : input.transcript,
      input.knowledge === undefined ? current.knowledge_artifact_id : input.knowledge, now(), documentId)
    return this.getDocument(documentId)!
  }

  publish(documentId: string, input: { artifactId: string; memoryRole: 'production' | 'test'; memoryProjectName: string; releaseStatus: string }): VideoDocumentRecord {
    const timestamp = now()
    this.database.db.exec('BEGIN IMMEDIATE')
    try {
      this.database.db.prepare(`UPDATE video_documents SET memory_state='published', memory_project_name=?, published_at=?, updated_at=? WHERE id=?`)
        .run(input.memoryProjectName, timestamp, timestamp, documentId)
      this.database.db.prepare(`UPDATE video_knowledge_points SET memory_state='published' WHERE video_document_id=?`).run(documentId)
      this.database.db.prepare(`
        INSERT INTO video_memory_publications(id, video_document_id, knowledge_artifact_id, memory_role, memory_project_name, release_status, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), documentId, input.artifactId, input.memoryRole, input.memoryProjectName, input.releaseStatus, timestamp)
      this.database.db.exec('COMMIT')
    } catch (error) {
      this.database.db.exec('ROLLBACK')
      throw error
    }
    return this.getDocument(documentId)!
  }

  integrityCheck(): { integrity: string; foreignKeys: number } {
    const integrity = this.database.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    const foreignKeys = (this.database.db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length
    return { integrity: integrity.integrity_check, foreignKeys }
  }

  view(jobId: string): VideoJobView {
    const job = this.getJob(jobId)
    if (job === undefined) throw new Error('VIDEO_JOB_NOT_FOUND')
    const document = job.video_document_id === null ? null : this.getDocument(job.video_document_id) ?? null
    const segments = document === null ? [] : this.listSegments(document.id)
    const points = document === null ? [] : this.listKnowledgePoints(document.id)
    const cards = document === null ? [] : this.cards.listCards(document.id)
    const cardBatches = document === null ? [] : this.cards.listBatches(document.id)
    const edges = document === null ? [] : this.listEdges(document.id)
    const chapters: VideoChapter[] = []
    for (let index = 0; index < segments.length; index += 5) {
      const group = segments.slice(index, index + 5)
      if (group.length === 0) continue
      chapters.push({
        index: chapters.length,
        title: group[0]!.text.replace(/\s+/gu, ' ').slice(0, 42) || `章节 ${chapters.length + 1}`,
        start_ms: group[0]!.start_ms,
        end_ms: group[group.length - 1]!.end_ms,
        segment_ids: group.map(item => item.id),
      })
    }
    const artifactIds = document === null ? [] : [
      document.source_artifact_id, document.transcript_artifact_id, document.knowledge_artifact_id,
      ...cardBatches.map(batch => batch.artifact_id),
    ].filter((id): id is string => id !== null)
    const artifacts = this.database.listArtifactRecordsByIds(artifactIds)
    const reviews = document?.knowledge_artifact_id === null || document?.knowledge_artifact_id === undefined
      ? [] : this.database.listArtifactReviewDecisions(document.knowledge_artifact_id)
    const logs = Array.isArray(job.metadata.process_logs) ? job.metadata.process_logs as VideoJobView['logs'] : []
    return {
      job, document, segments, knowledge_points: points, knowledge_cards: cards,
      knowledge_card_batches: cardBatches, edges, chapters, artifacts, reviews, logs,
    }
  }

  private mapJob(row: Record<string, unknown>): VideoJobRecord {
    return {
      id: String(row.id), project_id: String(row.project_id), task_id: row.task_id === null ? null : String(row.task_id),
      input_type: row.input_type as VideoInputType, input_value: String(row.input_value), title: String(row.title), language: String(row.language),
      status: row.status as VideoJobStatus, stage: String(row.stage), progress: Number(row.progress),
      source_path: row.source_path === null ? null : String(row.source_path), subtitle_path: row.subtitle_path === null ? null : String(row.subtitle_path),
      video_document_id: row.video_document_id === null ? null : String(row.video_document_id),
      error_code: row.error_code === null ? null : String(row.error_code), error_message: row.error_message === null ? null : String(row.error_message),
      created_at: String(row.created_at), updated_at: String(row.updated_at), completed_at: row.completed_at === null ? null : String(row.completed_at),
      metadata: json(row.metadata_json, {}),
    }
  }

  private mapDocument(row: Record<string, unknown>): VideoDocumentRecord {
    return {
      id: String(row.id), project_id: String(row.project_id), video_job_id: String(row.video_job_id),
      source_artifact_id: row.source_artifact_id === null ? null : String(row.source_artifact_id),
      transcript_artifact_id: row.transcript_artifact_id === null ? null : String(row.transcript_artifact_id),
      knowledge_artifact_id: row.knowledge_artifact_id === null ? null : String(row.knowledge_artifact_id),
      title: String(row.title), source_kind: row.source_kind as VideoInputType, source_reference: String(row.source_reference), language: String(row.language),
      duration_ms: Number(row.duration_ms), segment_count: Number(row.segment_count), knowledge_point_count: Number(row.knowledge_point_count),
      memory_state: row.memory_state as VideoMemoryState, memory_project_name: row.memory_project_name === null ? null : String(row.memory_project_name),
      published_at: row.published_at === null ? null : String(row.published_at), created_at: String(row.created_at), updated_at: String(row.updated_at),
      metadata: json(row.metadata_json, {}),
    }
  }

  private mapSegment(row: Record<string, unknown>): VideoSegmentRecord {
    const id = String(row.id)
    return {
      id, video_document_id: String(row.video_document_id), segment_index: Number(row.segment_index), start_ms: Number(row.start_ms), end_ms: Number(row.end_ms),
      text: String(row.text), text_hash: String(row.text_hash), embedding_provider: String(row.embedding_provider), embedding_model: String(row.embedding_model),
      embedding_dimensions: Number(row.embedding_dimensions), embedding: json<number[]>(row.embedding_json, []), created_at: String(row.created_at),
      citation: `[VideoSegment:${id} ${Number(row.start_ms)}-${Number(row.end_ms)}ms]`,
    }
  }

  private mapPoint(row: Record<string, unknown>): VideoKnowledgePointRecord {
    const id = String(row.id)
    return {
      id, video_document_id: String(row.video_document_id), segment_id: String(row.segment_id), title: String(row.title), summary: String(row.summary),
      keywords: json<string[]>(row.keywords_json, []), confidence: Number(row.confidence), memory_state: row.memory_state as VideoMemoryState,
      created_at: String(row.created_at), citation: `[KnowledgePoint:${id} VideoSegment:${String(row.segment_id)}]`,
    }
  }
}
