import { randomUUID } from 'node:crypto'
import type {
  KnowledgeBenchmarkSummary,
  KnowledgeCardBatchRecord,
  KnowledgeCardDuplicateStatus,
  KnowledgeCardRecord,
  KnowledgeCardReviewDecision,
  KnowledgeCardReviewRecord,
  KnowledgeCardStatus,
  KnowledgeCardValidationStatus,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

export interface CreateKnowledgeCardRow extends Omit<KnowledgeCardRecord, 'citation'> {}

export class KnowledgeCardRepository {
  constructor(readonly database: WorkbenchDatabase) {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_card_batches (
        id TEXT PRIMARY KEY,
        video_document_id TEXT NOT NULL REFERENCES video_documents(id) ON DELETE RESTRICT,
        task_id TEXT REFERENCES workbench_tasks(id) ON DELETE SET NULL,
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        extractor_provider TEXT NOT NULL CHECK(extractor_provider='qwen3_local'),
        extractor_model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('staged','approved','rejected')),
        card_count INTEGER NOT NULL CHECK(card_count >= 0),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        metrics_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS knowledge_cards (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES knowledge_card_batches(id) ON DELETE RESTRICT,
        video_document_id TEXT NOT NULL REFERENCES video_documents(id) ON DELETE RESTRICT,
        segment_id TEXT NOT NULL REFERENCES video_segments(id) ON DELETE RESTRICT,
        card_index INTEGER NOT NULL CHECK(card_index BETWEEN 0 AND 4),
        title TEXT NOT NULL,
        concept TEXT NOT NULL,
        core_claim TEXT NOT NULL,
        explanation TEXT NOT NULL,
        keywords_json TEXT NOT NULL,
        relations_json TEXT NOT NULL,
        source_segment_ids_json TEXT NOT NULL,
        source_start INTEGER NOT NULL CHECK(source_start >= 0),
        source_end INTEGER NOT NULL CHECK(source_end >= source_start),
        extractor_provider TEXT NOT NULL CHECK(extractor_provider='qwen3_local'),
        extractor_model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
        card_sha256 TEXT NOT NULL CHECK(length(card_sha256)=64),
        embedding_input_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('staged','approved','rejected','superseded')),
        validation_status TEXT NOT NULL CHECK(validation_status IN ('valid','needs_grounding_review')),
        grounding_issues_json TEXT NOT NULL DEFAULT '[]',
        duplicate_status TEXT NOT NULL CHECK(duplicate_status IN ('unique','possible_duplicate','same_source_duplicate')),
        duplicate_of_card_id TEXT REFERENCES knowledge_cards(id) ON DELETE RESTRICT,
        source_state TEXT NOT NULL CHECK(source_state IN ('current','outdated')),
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        supersedes_card_id TEXT REFERENCES knowledge_cards(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        UNIQUE(batch_id, segment_id, card_index)
      );
      CREATE TABLE IF NOT EXISTS knowledge_card_reviews (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES knowledge_cards(id) ON DELETE RESTRICT,
        decision TEXT NOT NULL CHECK(decision IN ('approved','needs_revision','rejected')),
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_benchmark_runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        extractor_model TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        selected_default TEXT NOT NULL CHECK(selected_default IN ('legacy','structured')),
        result_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_cards_document_segment
        ON knowledge_cards(video_document_id, segment_id, created_at, id);
      CREATE INDEX IF NOT EXISTS knowledge_cards_status
        ON knowledge_cards(status, validation_status, duplicate_status, source_state);
      CREATE INDEX IF NOT EXISTS knowledge_card_batches_document
        ON knowledge_card_batches(video_document_id, started_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS knowledge_card_reviews_card
        ON knowledge_card_reviews(card_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS knowledge_benchmark_runs_created
        ON knowledge_benchmark_runs(created_at DESC, id DESC);
    `)
  }

  createBatchWithCards(batch: KnowledgeCardBatchRecord, cards: CreateKnowledgeCardRow[]): KnowledgeCardBatchRecord {
    if (cards.length !== batch.card_count) throw new Error('KNOWLEDGE_CARD_COUNT_MISMATCH')
    this.database.db.exec('BEGIN IMMEDIATE')
    try {
      this.database.db.prepare(`
        INSERT INTO knowledge_card_batches(
          id, video_document_id, task_id, artifact_id, extractor_provider, extractor_model,
          prompt_version, status, card_count, started_at, completed_at, metrics_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(batch.id, batch.video_document_id, batch.task_id, batch.artifact_id, batch.extractor_provider,
        batch.extractor_model, batch.prompt_version, batch.status, batch.card_count, batch.started_at,
        batch.completed_at, JSON.stringify(batch.metrics))
      const insert = this.database.db.prepare(`
        INSERT INTO knowledge_cards(
          id, batch_id, video_document_id, segment_id, card_index, title, concept, core_claim,
          explanation, keywords_json, relations_json, source_segment_ids_json, source_start,
          source_end, extractor_provider, extractor_model, prompt_version, source_sha256,
          card_sha256, embedding_input_version, status, validation_status, grounding_issues_json,
          duplicate_status, duplicate_of_card_id, source_state, artifact_id, supersedes_card_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const card of cards) insert.run(
        card.id, card.batch_id, card.video_document_id, card.segment_id, card.card_index,
        card.title, card.concept, card.core_claim, card.explanation, JSON.stringify(card.keywords),
        JSON.stringify(card.relations), JSON.stringify(card.source_segment_ids), card.source_start,
        card.source_end, card.extractor_provider, card.extractor_model, card.prompt_version,
        card.source_sha256, card.card_sha256, card.embedding_input_version, card.status,
        card.validation_status, JSON.stringify(card.grounding_issues), card.duplicate_status,
        card.duplicate_of_card_id, card.source_state, card.artifact_id, card.supersedes_card_id,
        card.created_at,
      )
      this.database.db.exec('COMMIT')
    } catch (error) {
      this.database.db.exec('ROLLBACK')
      throw error
    }
    return this.getBatch(batch.id)!
  }

  attachArtifact(batchId: string, artifactId: string): void {
    this.database.db.exec('BEGIN IMMEDIATE')
    try {
      this.database.db.prepare('UPDATE knowledge_card_batches SET artifact_id=? WHERE id=?').run(artifactId, batchId)
      this.database.db.prepare('UPDATE knowledge_cards SET artifact_id=? WHERE batch_id=?').run(artifactId, batchId)
      this.database.db.exec('COMMIT')
    } catch (error) {
      this.database.db.exec('ROLLBACK')
      throw error
    }
  }

  updateBatchMetrics(batchId: string, metrics: Record<string, unknown>): void {
    this.database.db.prepare('UPDATE knowledge_card_batches SET metrics_json=? WHERE id=?').run(JSON.stringify(metrics), batchId)
  }

  getBatch(id: string): KnowledgeCardBatchRecord | undefined {
    const row = this.database.db.prepare('SELECT * FROM knowledge_card_batches WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapBatch(row)
  }

  listBatches(documentId?: string): KnowledgeCardBatchRecord[] {
    const rows = documentId === undefined
      ? this.database.db.prepare('SELECT * FROM knowledge_card_batches ORDER BY started_at DESC, id DESC').all()
      : this.database.db.prepare('SELECT * FROM knowledge_card_batches WHERE video_document_id=? ORDER BY started_at DESC, id DESC').all(documentId)
    return (rows as Record<string, unknown>[]).map(row => this.mapBatch(row))
  }

  getCard(id: string): KnowledgeCardRecord | undefined {
    this.refreshSourceStates()
    const row = this.database.db.prepare('SELECT * FROM knowledge_cards WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapCard(row)
  }

  listCards(documentId?: string, includeSuperseded = false): KnowledgeCardRecord[] {
    this.refreshSourceStates(documentId)
    const conditions = [includeSuperseded ? '1=1' : "status<>'superseded'"]
    const values: string[] = []
    if (documentId !== undefined) { conditions.push('video_document_id=?'); values.push(documentId) }
    const rows = this.database.db.prepare(`
      SELECT * FROM knowledge_cards WHERE ${conditions.join(' AND ')}
      ORDER BY video_document_id, source_start, segment_id, card_index, created_at, id
    `).all(...values) as Record<string, unknown>[]
    return rows.map(row => this.mapCard(row))
  }

  listCardsForSegments(segmentIds: string[]): KnowledgeCardRecord[] {
    if (segmentIds.length === 0) return []
    const placeholders = segmentIds.map(() => '?').join(',')
    const rows = this.database.db.prepare(`
      SELECT * FROM knowledge_cards WHERE segment_id IN (${placeholders}) AND status<>'superseded'
      ORDER BY created_at, id
    `).all(...segmentIds) as Record<string, unknown>[]
    return rows.map(row => this.mapCard(row))
  }

  listProjectCards(projectId: string, includeSuperseded = false): KnowledgeCardRecord[] {
    this.refreshSourceStates()
    const rows = this.database.db.prepare(`
      SELECT c.* FROM knowledge_cards c
      JOIN video_documents d ON d.id=c.video_document_id
      WHERE d.project_id=? ${includeSuperseded ? '' : "AND c.status<>'superseded'"}
      ORDER BY c.created_at, c.id
    `).all(projectId) as Record<string, unknown>[]
    return rows.map(row => this.mapCard(row))
  }

  updateDuplicate(id: string, status: KnowledgeCardDuplicateStatus, duplicateOf: string | null): KnowledgeCardRecord {
    this.database.db.prepare('UPDATE knowledge_cards SET duplicate_status=?, duplicate_of_card_id=? WHERE id=?')
      .run(status, duplicateOf, id)
    const card = this.getCard(id)
    if (card === undefined) throw new Error('KNOWLEDGE_CARD_NOT_FOUND')
    return card
  }

  supersede(previousId: string, replacementId: string): void {
    const replacement = this.getCard(replacementId)
    if (replacement === undefined) throw new Error('KNOWLEDGE_CARD_NOT_FOUND')
    this.database.db.exec('BEGIN IMMEDIATE')
    try {
      this.database.db.prepare("UPDATE knowledge_cards SET status='superseded' WHERE id=?").run(previousId)
      this.database.db.prepare('UPDATE knowledge_cards SET supersedes_card_id=? WHERE id=?').run(previousId, replacementId)
      this.database.db.exec('COMMIT')
    } catch (error) {
      this.database.db.exec('ROLLBACK')
      throw error
    }
  }

  addReview(cardId: string, decision: KnowledgeCardReviewDecision, note: string): KnowledgeCardReviewRecord {
    const card = this.getCard(cardId)
    if (card === undefined) throw new Error('KNOWLEDGE_CARD_NOT_FOUND')
    const record: KnowledgeCardReviewRecord = { id: randomUUID(), card_id: cardId, decision, note, created_at: new Date().toISOString() }
    const status: KnowledgeCardStatus = decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'staged'
    this.database.db.exec('BEGIN IMMEDIATE')
    try {
      this.database.db.prepare('INSERT INTO knowledge_card_reviews(id, card_id, decision, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(record.id, record.card_id, record.decision, record.note, record.created_at)
      this.database.db.prepare('UPDATE knowledge_cards SET status=? WHERE id=?').run(status, cardId)
      this.database.db.exec('COMMIT')
    } catch (error) {
      this.database.db.exec('ROLLBACK')
      throw error
    }
    return record
  }

  listReviews(cardId: string): KnowledgeCardReviewRecord[] {
    const rows = this.database.db.prepare('SELECT * FROM knowledge_card_reviews WHERE card_id=? ORDER BY created_at DESC, id DESC')
      .all(cardId) as Record<string, unknown>[]
    return rows.map(row => ({
      id: String(row.id), card_id: String(row.card_id), decision: row.decision as KnowledgeCardReviewDecision,
      note: String(row.note), created_at: String(row.created_at),
    }))
  }

  refreshSourceStates(documentId?: string): number {
    const statement = documentId === undefined
      ? this.database.db.prepare(`
          UPDATE knowledge_cards SET source_state=CASE
            WHEN source_sha256=(SELECT text_hash FROM video_segments WHERE id=knowledge_cards.segment_id) THEN 'current'
            ELSE 'outdated' END
        `)
      : this.database.db.prepare(`
          UPDATE knowledge_cards SET source_state=CASE
            WHEN source_sha256=(SELECT text_hash FROM video_segments WHERE id=knowledge_cards.segment_id) THEN 'current'
            ELSE 'outdated' END WHERE video_document_id=?
        `)
    return Number(documentId === undefined ? statement.run().changes : statement.run(documentId).changes)
  }

  counts(): {
    cards: number
    staged: number
    approved: number
    rejected: number
    needs_grounding_review: number
    possible_duplicates: number
    same_source_duplicates: number
  } {
    const row = this.database.db.prepare(`
      SELECT COUNT(*) AS cards,
        SUM(CASE WHEN status='staged' THEN 1 ELSE 0 END) AS staged,
        SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN validation_status='needs_grounding_review' THEN 1 ELSE 0 END) AS needs_grounding_review,
        SUM(CASE WHEN duplicate_status='possible_duplicate' THEN 1 ELSE 0 END) AS possible_duplicates,
        SUM(CASE WHEN duplicate_status='same_source_duplicate' THEN 1 ELSE 0 END) AS same_source_duplicates
      FROM knowledge_cards WHERE status<>'superseded'
    `).get() as Record<string, unknown>
    return {
      cards: Number(row.cards ?? 0), staged: Number(row.staged ?? 0), approved: Number(row.approved ?? 0),
      rejected: Number(row.rejected ?? 0), needs_grounding_review: Number(row.needs_grounding_review ?? 0),
      possible_duplicates: Number(row.possible_duplicates ?? 0), same_source_duplicates: Number(row.same_source_duplicates ?? 0),
    }
  }

  saveBenchmark(summary: KnowledgeBenchmarkSummary): void {
    this.database.db.prepare(`
      INSERT INTO knowledge_benchmark_runs(id, created_at, extractor_model, embedding_model, selected_default, result_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), summary.created_at, summary.extractor_model, summary.embedding_model, summary.selected_default, JSON.stringify(summary))
  }

  latestBenchmark(): KnowledgeBenchmarkSummary | null {
    const row = this.database.db.prepare('SELECT result_json FROM knowledge_benchmark_runs ORDER BY created_at DESC, id DESC LIMIT 1')
      .get() as { result_json?: string } | undefined
    return row?.result_json === undefined ? null : parseJson(row.result_json, null)
  }

  private mapBatch(row: Record<string, unknown>): KnowledgeCardBatchRecord {
    return {
      id: String(row.id), video_document_id: String(row.video_document_id), task_id: row.task_id === null ? null : String(row.task_id),
      artifact_id: row.artifact_id === null ? null : String(row.artifact_id), extractor_provider: 'qwen3_local',
      extractor_model: String(row.extractor_model), prompt_version: String(row.prompt_version), status: row.status as KnowledgeCardBatchRecord['status'],
      card_count: Number(row.card_count), started_at: String(row.started_at), completed_at: row.completed_at === null ? null : String(row.completed_at),
      metrics: parseJson(row.metrics_json, {}),
    }
  }

  private mapCard(row: Record<string, unknown>): KnowledgeCardRecord {
    const id = String(row.id)
    return {
      id, batch_id: String(row.batch_id), video_document_id: String(row.video_document_id), segment_id: String(row.segment_id),
      card_index: Number(row.card_index), title: String(row.title), concept: String(row.concept), core_claim: String(row.core_claim),
      explanation: String(row.explanation), keywords: parseJson(row.keywords_json, []), relations: parseJson(row.relations_json, []),
      source_segment_ids: parseJson(row.source_segment_ids_json, []), source_start: Number(row.source_start), source_end: Number(row.source_end),
      extractor_provider: 'qwen3_local', extractor_model: String(row.extractor_model), prompt_version: String(row.prompt_version),
      source_sha256: String(row.source_sha256), card_sha256: String(row.card_sha256), embedding_input_version: String(row.embedding_input_version),
      status: row.status as KnowledgeCardStatus, validation_status: row.validation_status as KnowledgeCardValidationStatus,
      grounding_issues: parseJson(row.grounding_issues_json, []), duplicate_status: row.duplicate_status as KnowledgeCardDuplicateStatus,
      duplicate_of_card_id: row.duplicate_of_card_id === null ? null : String(row.duplicate_of_card_id),
      source_state: row.source_state as KnowledgeCardRecord['source_state'], artifact_id: row.artifact_id === null ? null : String(row.artifact_id),
      supersedes_card_id: row.supersedes_card_id === null ? null : String(row.supersedes_card_id), created_at: String(row.created_at),
      citation: `[KnowledgeCard:${id} VideoSegment:${String(row.segment_id)} ${Number(row.source_start)}-${Number(row.source_end)}ms]`,
    }
  }
}
