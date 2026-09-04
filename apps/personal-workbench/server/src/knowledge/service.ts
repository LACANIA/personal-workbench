import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  KnowledgeBenchmarkSummary,
  KnowledgeCardDetail,
  KnowledgeCardRecord,
  KnowledgeCardReviewDecision,
  KnowledgeExtractionDiagnostics,
  KnowledgeExtractionMetrics,
  KnowledgeExtractionResult,
  VideoSegmentRecord,
} from '../../../shared/contracts/index.ts'
import { ArtifactEvidenceService } from '../artifacts/evidence-service.ts'
import { ArtifactService } from '../artifacts/service.ts'
import { WorkbenchDatabase } from '../database.ts'
import { SemanticRetrievalService } from '../retrieval/service.ts'
import { assertAllowedExisting } from '../security/path-policy.ts'
import { VideoKnowledgeRepository } from '../video/repository.ts'
import { cardEmbeddingText, KnowledgeDedupService } from './dedup.ts'
import {
  KNOWLEDGE_EXTRACTION_CONTEXT_LENGTH,
  KNOWLEDGE_EXTRACTION_MAX_CARDS,
  KNOWLEDGE_EXTRACTION_PROMPT_VERSION,
  KNOWLEDGE_EXTRACTION_TEMPERATURE,
  KNOWLEDGE_EXTRACTION_TOP_P,
  type ExtractedKnowledgeCard,
  type KnowledgeExtractionProvider,
  Qwen3KnowledgeExtractionProvider,
} from './extraction.ts'
import { GroundingValidator } from './grounding.ts'
import { KnowledgeCardRepository, type CreateKnowledgeCardRow } from './repository.ts'

const execFileAsync = promisify(execFile)
export const KNOWLEDGE_CARD_EMBEDDING_INPUT_VERSION = 'knowledge-card-embedding-v1'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1))
  return Number(sorted[index]!.toFixed(3))
}

function safeNote(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > 2_000 || value.includes('\0')) throw new Error('INVALID_KNOWLEDGE_REVIEW_NOTE')
  return value.trim()
}

function cardHash(card: ExtractedKnowledgeCard): string {
  return sha256(JSON.stringify({
    title: card.title, concept: card.concept, core_claim: card.core_claim,
    explanation: card.explanation, keywords: card.keywords, relations: card.relations,
  }))
}

async function sampleVramMb(): Promise<number | null> {
  try {
    const result = await execFileAsync('nvidia-smi.exe', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], {
      windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024,
    })
    const values = result.stdout.split(/\r?\n/gu).map(value => Number(value.trim())).filter(Number.isFinite)
    return values.length === 0 ? null : Math.max(...values)
  } catch { return null }
}

export interface ExtractDocumentOptions {
  segment_ids?: string[]
  supersedes_card_id?: string
}

export class KnowledgeCardService {
  readonly cards: KnowledgeCardRepository
  readonly grounding = new GroundingValidator()
  readonly dedup: KnowledgeDedupService

  constructor(
    readonly database: WorkbenchDatabase,
    readonly video: VideoKnowledgeRepository,
    readonly artifacts: ArtifactService,
    readonly evidence: ArtifactEvidenceService,
    readonly retrieval: SemanticRetrievalService,
    readonly provider: KnowledgeExtractionProvider = new Qwen3KnowledgeExtractionProvider(),
  ) {
    this.cards = video.cards
    this.dedup = new KnowledgeDedupService(retrieval.semanticProvider)
  }

  async extractDocument(documentId: string, options: ExtractDocumentOptions = {}): Promise<KnowledgeExtractionResult> {
    const document = this.video.getDocument(documentId)
    if (document === undefined) throw new Error('VIDEO_DOCUMENT_NOT_FOUND')
    const job = this.video.getJob(document.video_job_id)
    if (job === undefined) throw new Error('VIDEO_JOB_NOT_FOUND')
    const project = this.database.getProjectContext(document.project_id)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const allSegments = this.video.listSegments(document.id)
    const selectedIds = options.segment_ids === undefined ? null : new Set(options.segment_ids)
    const segments = selectedIds === null ? allSegments : allSegments.filter(segment => selectedIds.has(segment.id))
    if (segments.length === 0 || selectedIds !== null && segments.length !== selectedIds.size) throw new Error('KNOWLEDGE_SOURCE_SEGMENT_NOT_FOUND')
    const startedAt = new Date().toISOString()
    const batchId = randomUUID()
    const metadata = this.provider.metadata()
    const pending: CreateKnowledgeCardRow[] = []
    const latencies: number[] = []
    let promptTokens = 0
    let outputTokens = 0
    let repairs = 0
    let sampledPeak = await sampleVramMb()

    for (const segment of segments) {
      const position = allSegments.findIndex(candidate => candidate.id === segment.id)
      const previous = position > 0 ? allSegments[position - 1] : undefined
      const next = position >= 0 && position + 1 < allSegments.length ? allSegments[position + 1] : undefined
      const extraction = await this.provider.extract(segment, {
        video_title: document.title,
        ...(previous === undefined ? {} : { previous_segment: previous }),
        ...(next === undefined ? {} : { next_segment: next }),
      })
      latencies.push(extraction.metrics.duration_ms)
      promptTokens += extraction.metrics.prompt_tokens
      outputTokens += extraction.metrics.output_tokens
      repairs += extraction.metrics.repair_count
      const vram = await sampleVramMb()
      if (vram !== null) sampledPeak = sampledPeak === null ? vram : Math.max(sampledPeak, vram)
      extraction.cards.forEach((card, cardIndex) => {
        const grounding = this.grounding.validate(card, segment.text, [previous?.text ?? '', next?.text ?? ''])
        const createdAt = new Date().toISOString()
        pending.push({
          id: randomUUID(), batch_id: batchId, video_document_id: document.id, segment_id: segment.id,
          card_index: cardIndex, title: card.title, concept: card.concept, core_claim: card.core_claim,
          explanation: card.explanation, keywords: card.keywords, relations: card.relations,
          source_segment_ids: extraction.source_segment_ids, source_start: segment.start_ms, source_end: segment.end_ms,
          extractor_provider: metadata.provider, extractor_model: metadata.model, prompt_version: metadata.prompt_version,
          source_sha256: segment.text_hash, card_sha256: cardHash(card), embedding_input_version: KNOWLEDGE_CARD_EMBEDDING_INPUT_VERSION,
          status: 'staged', validation_status: grounding.valid ? 'valid' : 'needs_grounding_review',
          grounding_issues: grounding.issues, duplicate_status: 'unique', duplicate_of_card_id: null,
          source_state: 'current', artifact_id: null, supersedes_card_id: null, created_at: createdAt,
        })
      })
    }

    const totalDuration = latencies.reduce((sum, value) => sum + value, 0)
    const metrics: KnowledgeExtractionMetrics = {
      segment_count: segments.length, card_count: pending.length, valid_card_count: pending.length,
      source_link_count: pending.filter(card => card.source_segment_ids.includes(card.segment_id)).length,
      grounding_pass_count: pending.filter(card => card.validation_status === 'valid').length,
      possible_duplicate_count: 0, same_source_duplicate_count: 0, repair_count: repairs,
      total_duration_ms: Number(totalDuration.toFixed(3)),
      average_segment_latency_ms: Number((totalDuration / segments.length).toFixed(3)),
      p50_segment_latency_ms: percentile(latencies, 0.5), p95_segment_latency_ms: percentile(latencies, 0.95),
      prompt_tokens: promptTokens, output_tokens: outputTokens, sampled_peak_vram_mb: sampledPeak,
    }
    const completedAt = new Date().toISOString()
    this.cards.createBatchWithCards({
      id: batchId, video_document_id: document.id, task_id: job.task_id, artifact_id: null,
      extractor_provider: metadata.provider, extractor_model: metadata.model, prompt_version: metadata.prompt_version,
      status: 'staged', card_count: pending.length, started_at: startedAt, completed_at: completedAt, metrics: { ...metrics },
    }, pending)

    await this.retrieval.indexDocument(document.id)
    const projectCards = this.cards.listProjectCards(document.project_id, true)
    const prior = projectCards.filter(card => card.batch_id !== batchId)
    const processed: KnowledgeCardRecord[] = []
    for (const current of this.cards.listCards(document.id).filter(card => card.batch_id === batchId)) {
      const decision = await this.dedup.compare(current, [...prior, ...processed])
      processed.push(this.cards.updateDuplicate(current.id, decision.status, decision.duplicate_of_card_id))
    }
    metrics.possible_duplicate_count = processed.filter(card => card.duplicate_status === 'possible_duplicate').length
    metrics.same_source_duplicate_count = processed.filter(card => card.duplicate_status === 'same_source_duplicate').length
    this.cards.updateBatchMetrics(batchId, { ...metrics })

    const outputRoot = typeof job.metadata.output_directory === 'string'
      ? job.metadata.output_directory
      : path.join(project.rootPath, 'output', 'video-knowledge', job.id)
    const batchDirectory = path.join(outputRoot, 'knowledge-cards', batchId)
    await mkdir(batchDirectory, { recursive: true })
    await assertAllowedExisting(batchDirectory, 'directory')
    const filePath = path.join(batchDirectory, 'knowledge-cards.json')
    await writeFile(filePath, `${JSON.stringify({
      schema: 'personal-workbench.knowledge-cards.v1', batch_id: batchId, video_document_id: document.id,
      extractor: metadata, embedding_input_version: KNOWLEDGE_CARD_EMBEDDING_INPUT_VERSION,
      status: 'staged', metrics, cards: processed,
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    const artifact = await this.artifacts.register({
      project_id: document.project_id, ...(job.task_id === null ? {} : { task_id: job.task_id }),
      file_path: filePath, artifact_type: 'dataset', name: `knowledge-cards-${batchId.slice(0, 8)}.json`,
      metadata: {
        origin: 'structured-knowledge-extraction', video_document_id: document.id, batch_id: batchId,
        extractor_model: metadata.model, prompt_version: metadata.prompt_version, status: 'staged',
      },
      ...(document.transcript_artifact_id === null ? {} : {
        evidence: [{ source_type: 'artifact', source_id: document.transcript_artifact_id, relation_type: 'derived_from' }],
      }),
    })
    this.cards.attachArtifact(batchId, artifact.id)
    if (options.supersedes_card_id !== undefined) {
      const replacement = processed[0]
      if (replacement === undefined) throw new Error('KNOWLEDGE_REGENERATION_EMPTY')
      this.cards.supersede(options.supersedes_card_id, replacement.id)
    }
    if (job.task_id !== null) this.database.addEvent(job.task_id, 'knowledge.cards.generated', 'workbench', {
      videoDocumentId: document.id, batchId, cardCount: processed.length, artifactId: artifact.id,
      extractorModel: metadata.model, promptVersion: metadata.prompt_version, status: 'staged',
    })
    return { batch: this.cards.getBatch(batchId)!, cards: this.cards.listCards(document.id).filter(card => card.batch_id === batchId), artifact, metrics }
  }

  list(documentId: string): KnowledgeCardRecord[] {
    if (this.video.getDocument(documentId) === undefined) throw new Error('VIDEO_DOCUMENT_NOT_FOUND')
    return this.cards.listCards(documentId)
  }

  detail(cardId: string): KnowledgeCardDetail {
    const card = this.cards.getCard(cardId)
    if (card === undefined) throw new Error('KNOWLEDGE_CARD_NOT_FOUND')
    const document = this.video.getDocument(card.video_document_id)
    const segment = this.video.listSegments(card.video_document_id).find(item => item.id === card.segment_id)
    if (document === undefined || segment === undefined) throw new Error('KNOWLEDGE_CARD_SOURCE_NOT_FOUND')
    const artifact = card.artifact_id === null ? null : this.artifacts.get(card.artifact_id)
    return {
      card, document, segment, artifact,
      evidence: artifact === null ? [] : this.evidence.forArtifact(artifact.id).evidence,
      reviews: this.cards.listReviews(card.id),
    }
  }

  review(cardId: string, decision: KnowledgeCardReviewDecision, note?: unknown): KnowledgeCardDetail {
    if (!['approved', 'needs_revision', 'rejected'].includes(decision)) throw new Error('INVALID_KNOWLEDGE_REVIEW_DECISION')
    this.cards.addReview(cardId, decision, safeNote(note))
    if (decision === 'approved') this.retrieval.markCardApproved(cardId)
    return this.detail(cardId)
  }

  async regenerate(cardId: string): Promise<KnowledgeExtractionResult> {
    const card = this.cards.getCard(cardId)
    if (card === undefined) throw new Error('KNOWLEDGE_CARD_NOT_FOUND')
    return this.extractDocument(card.video_document_id, { segment_ids: [card.segment_id], supersedes_card_id: card.id })
  }

  reviewSamples(limit = 10): Array<{ segment: VideoSegmentRecord; legacy: string; cards: KnowledgeCardRecord[] }> {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)))
    const rows = this.database.db.prepare(`
      SELECT s.id AS segment_id, p.summary AS legacy
      FROM video_segments s JOIN video_knowledge_points p ON p.segment_id=s.id
      WHERE EXISTS(SELECT 1 FROM knowledge_cards c WHERE c.segment_id=s.id AND c.status<>'superseded')
      ORDER BY s.text_hash, s.id LIMIT ?
    `).all(safeLimit) as Array<{ segment_id: string; legacy: string }>
    return rows.map(row => {
      const cards = this.cards.listCardsForSegments([row.segment_id])
      const segment = this.video.listSegments(cards[0]!.video_document_id).find(candidate => candidate.id === row.segment_id)!
      return { segment, legacy: row.legacy, cards }
    })
  }

  async diagnostics(): Promise<KnowledgeExtractionDiagnostics> {
    const health = await this.provider.health()
    const metadata = this.provider.metadata()
    const counts = this.cards.counts()
    return {
      status: health.available ? 'available' : 'unavailable', provider: metadata.provider, model: metadata.model,
      endpoint: metadata.endpoint, prompt_version: metadata.prompt_version, structured_output: metadata.structured_output,
      thinking: metadata.thinking, temperature: metadata.temperature, top_p: metadata.top_p,
      context_length: KNOWLEDGE_EXTRACTION_CONTEXT_LENGTH, maximum_cards_per_segment: KNOWLEDGE_EXTRACTION_MAX_CARDS,
      card_count: counts.cards, staged: counts.staged, approved: counts.approved, rejected: counts.rejected,
      needs_grounding_review: counts.needs_grounding_review, possible_duplicates: counts.possible_duplicates,
      same_source_duplicates: counts.same_source_duplicates, latest_benchmark: this.cards.latestBenchmark(),
    }
  }

  saveBenchmark(summary: KnowledgeBenchmarkSummary): void { this.cards.saveBenchmark(summary) }

  embeddingText(card: KnowledgeCardRecord): string { return cardEmbeddingText(card) }
}
