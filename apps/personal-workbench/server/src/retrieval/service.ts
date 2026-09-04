import type {
  EmbeddingRecord,
  RetrievalBenchmarkSummary,
  RetrievalDiagnostics,
  VideoSearchInput,
  VideoSearchResult,
} from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { WorkbenchDatabase } from '../database.ts'
import {
  cosineSimilarity,
  LocalHashEmbeddingProvider,
  OllamaEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderHealth,
} from '../video/embedding.ts'
import { EmbeddingRecordRepository, type EmbeddingEntityType, type IndexableEntity } from './repository.ts'

export const DEFAULT_SEMANTIC_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'

function requiredQuery(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 256 || value.includes('\0')) {
    throw new Error('INVALID_RETRIEVAL_QUERY')
  }
  return value.trim()
}

function entityType(value: unknown): EmbeddingEntityType | undefined {
  if (value === undefined || value === 'all') return undefined
  if (value !== 'video_segment' && value !== 'knowledge_point' && value !== 'knowledge_card') throw new Error('INVALID_RETRIEVAL_ENTITY_TYPE')
  return value
}

function topK(value: unknown): number {
  const parsed = value === undefined ? 5 : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) throw new Error('INVALID_RETRIEVAL_TOP_K')
  return parsed
}

function configuredDefault(): 'semantic' | 'local-hash-v1' {
  return PATHS.embeddingProvider === 'ollama' && PATHS.embeddingModel !== null ? 'semantic' : 'local-hash-v1'
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = []
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size))
  return output
}

export interface IndexResult {
  indexed: number
  local_hash_indexed: number
  semantic_indexed: number
  semantic_available: boolean
  semantic_error: string | null
  elapsed_ms: number
}

export class SemanticRetrievalService {
  readonly repository: EmbeddingRecordRepository
  readonly localProvider: LocalHashEmbeddingProvider
  readonly semanticProvider: OllamaEmbeddingProvider
  private formalHealth: { value: EmbeddingProviderHealth; observedAt: number } | null = null
  private readonly queryLatencies: number[] = []

  constructor(
    readonly database: WorkbenchDatabase,
    readonly semanticModel = PATHS.embeddingModel ?? DEFAULT_SEMANTIC_EMBEDDING_MODEL,
    readonly endpoint = PATHS.ollamaEndpoint,
    localDimensions = 256,
  ) {
    this.repository = new EmbeddingRecordRepository(database)
    this.localProvider = new LocalHashEmbeddingProvider(localDimensions)
    this.semanticProvider = new OllamaEmbeddingProvider(endpoint, semanticModel)
  }

  async indexDocument(documentId: string): Promise<IndexResult> {
    const entities = this.repository.listIndexableEntities().filter(entity => entity.video_document_id === documentId)
    if (entities.length === 0) throw new Error('VIDEO_DOCUMENT_NOT_FOUND')
    return this.indexEntities(entities, configuredDefault() === 'semantic')
  }

  async indexProject(projectId?: string): Promise<IndexResult> {
    return this.indexEntities(this.repository.listIndexableEntities(projectId), true)
  }

  async indexEntities(entities: IndexableEntity[], includeSemantic = true): Promise<IndexResult> {
    const started = performance.now()
    let localCount = 0
    let semanticCount = 0
    for (const group of chunks(entities, 64)) {
      const results = await this.localProvider.embedBatch(group.map(entity => entity.text))
      results.forEach((result, index) => {
        const entity = group[index]!
        this.repository.upsert({
          entity_type: entity.entity_type, entity_id: entity.entity_id, provider: result.provider,
          model: result.model, vector: result.vector, content_sha256: entity.content_sha256, index_state: entity.index_state,
        })
        localCount += 1
      })
    }
    if (!includeSemantic) {
      return {
        indexed: localCount, local_hash_indexed: localCount, semantic_indexed: 0,
        semantic_available: false, semantic_error: null,
        elapsed_ms: Number((performance.now() - started).toFixed(3)),
      }
    }
    let semanticError: string | null = null
    try {
      for (const group of chunks(entities, 32)) {
        const results = await this.semanticProvider.embedBatch(group.map(entity => entity.text))
        results.forEach((result, index) => {
          const entity = group[index]!
          this.repository.upsert({
            entity_type: entity.entity_type, entity_id: entity.entity_id, provider: result.provider,
            model: result.model, vector: result.vector, content_sha256: entity.content_sha256, index_state: entity.index_state,
          })
          semanticCount += 1
        })
      }
      this.formalHealth = {
        value: {
          available: true, provider: 'ollama', model: this.semanticModel,
          dimension: this.semanticProvider.metadata().dimension,
          latency_ms: Number((performance.now() - started).toFixed(3)), diagnostic: `Ollama /api/embed · ${this.semanticModel}`,
        },
        observedAt: Date.now(),
      }
    } catch (error) {
      semanticError = error instanceof Error ? error.message : String(error)
      this.formalHealth = {
        value: {
          available: false, provider: 'ollama', model: this.semanticModel, dimension: this.semanticProvider.metadata().dimension,
          latency_ms: Number((performance.now() - started).toFixed(3)), diagnostic: semanticError,
        },
        observedAt: Date.now(),
      }
    }
    return {
      indexed: localCount + semanticCount, local_hash_indexed: localCount, semantic_indexed: semanticCount,
      semantic_available: semanticCount === entities.length, semantic_error: semanticError,
      elapsed_ms: Number((performance.now() - started).toFixed(3)),
    }
  }

  async search(input: VideoSearchInput): Promise<VideoSearchResult[]> {
    const query = requiredQuery(input.query)
    const limit = topK(input.top_k)
    const requestedMode = input.provider ?? configuredDefault()
    const selectedEntityType = entityType(input.entity_type)
    const started = performance.now()
    let provider: EmbeddingProvider = requestedMode === 'semantic' ? this.semanticProvider : this.localProvider
    let providerName: EmbeddingRecord['provider'] = requestedMode === 'semantic' ? 'ollama' : 'local-hash-v1'
    let model = requestedMode === 'semantic' ? this.semanticModel : 'unicode-ngram-sha256'
    let fallbackUsed = false
    let fallbackReason: string | null = null

    const entities = this.repository.listIndexableEntities(input.project_id, selectedEntityType)
    await this.ensureProviderIndex(entities, this.localProvider)
    if (requestedMode === 'semantic') {
      try {
        await this.ensureProviderIndex(entities, this.semanticProvider)
      } catch (error) {
        provider = this.localProvider
        providerName = 'local-hash-v1'
        model = 'unicode-ngram-sha256'
        fallbackUsed = true
        fallbackReason = error instanceof Error ? error.message : String(error)
      }
    }

    let queryEmbedding
    try {
      queryEmbedding = await provider.embedText(query)
    } catch (error) {
      provider = this.localProvider
      providerName = 'local-hash-v1'
      model = 'unicode-ngram-sha256'
      fallbackUsed = true
      fallbackReason = error instanceof Error ? error.message : String(error)
      queryEmbedding = await provider.embedText(query)
      await this.ensureProviderIndex(entities, provider)
    }
    const stored = this.repository.listStored({
      provider: providerName, model, ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
      ...(selectedEntityType === undefined ? {} : { entity_type: selectedEntityType }), include_staged: true,
    })
    const scored = stored.map(record => ({ record, score: cosineSimilarity(queryEmbedding.vector, record.vector) }))
      .sort((left, right) => right.score - left.score
        || left.record.entity.start_ms - right.record.entity.start_ms
        || left.record.entity.entity_id.localeCompare(right.record.entity.entity_id))
      .slice(0, limit)
    const elapsed = Number((performance.now() - started).toFixed(3))
    this.queryLatencies.push(elapsed)
    if (this.queryLatencies.length > 200) this.queryLatencies.shift()
    return scored.map(({ record, score }) => this.result(record.entity, score, record.dimension, providerName, model, fallbackUsed, fallbackReason))
  }

  async diagnostics(): Promise<RetrievalDiagnostics> {
    const formal = await this.semanticHealth()
    const counts = this.repository.diagnostics()
    const average = this.queryLatencies.length === 0 ? null
      : Number((this.queryLatencies.reduce((sum, value) => sum + value, 0) / this.queryLatencies.length).toFixed(3))
    return {
      status: formal.available ? 'semantic' : 'fallback',
      provider: formal.available ? 'ollama' : 'local-hash-v1',
      model: formal.available ? this.semanticModel : 'unicode-ngram-sha256',
      dimension: formal.dimension ?? 256, runtime: formal.available ? 'ollama' : 'node',
      indexed_entities: {
        total: counts.video_segments + counts.knowledge_points + counts.knowledge_cards,
        video_segments: counts.video_segments, knowledge_points: counts.knowledge_points, knowledge_cards: counts.knowledge_cards,
        staged: counts.staged, approved: counts.approved,
      },
      stale_embeddings: counts.stale, average_latency_ms: average,
      fallback_available: true, fallback_model: 'unicode-ngram-sha256',
      formal_provider_available: formal.available, formal_provider_diagnostic: formal.diagnostic,
      default_mode: configuredDefault(), benchmark: this.repository.latestBenchmark(),
    }
  }

  markDocumentApproved(documentId: string): number {
    return this.repository.markDocumentApproved(documentId)
  }

  markCardApproved(cardId: string): number {
    return this.repository.markCardApproved(cardId)
  }

  saveBenchmark(summary: RetrievalBenchmarkSummary): void {
    this.repository.saveBenchmark(summary)
  }

  private async semanticHealth(): Promise<EmbeddingProviderHealth> {
    if (this.formalHealth !== null && Date.now() - this.formalHealth.observedAt < 60_000) return this.formalHealth.value
    const value = await this.semanticProvider.health()
    this.formalHealth = { value, observedAt: Date.now() }
    return value
  }

  private async ensureProviderIndex(entities: IndexableEntity[], provider: EmbeddingProvider): Promise<void> {
    const metadata = provider.metadata()
    const missing = entities.filter(entity => this.repository.getActive(entity.entity_type, entity.entity_id, metadata.provider, metadata.model)?.content_sha256 !== entity.content_sha256)
    for (const group of chunks(missing, metadata.provider === 'ollama' ? 32 : 64)) {
      const vectors = await provider.embedBatch(group.map(entity => entity.text))
      vectors.forEach((result, index) => {
        const entity = group[index]!
        this.repository.upsert({
          entity_type: entity.entity_type, entity_id: entity.entity_id, provider: result.provider,
          model: result.model, vector: result.vector, content_sha256: entity.content_sha256, index_state: entity.index_state,
        })
      })
    }
  }

  private result(
    entity: IndexableEntity,
    score: number,
    dimension: number,
    provider: EmbeddingRecord['provider'],
    model: string,
    fallbackUsed: boolean,
    fallbackReason: string | null,
  ): VideoSearchResult {
    const evidence = entity.knowledge_artifact_id === null ? [] : this.database.listArtifactEvidenceLinks(entity.knowledge_artifact_id)
    const segmentCitation = `[VideoSegment:${entity.segment_id} ${entity.start_ms}-${entity.end_ms}ms]`
    const knowledgeCitation = entity.knowledge_point_id === null ? null : `[KnowledgePoint:${entity.knowledge_point_id} VideoSegment:${entity.segment_id}]`
    const cardCitation = entity.knowledge_card_id === null ? null : `[KnowledgeCard:${entity.knowledge_card_id} VideoSegment:${entity.segment_id} ${entity.start_ms}-${entity.end_ms}ms]`
    return {
      video_document_id: entity.video_document_id, segment_id: entity.segment_id,
      knowledge_point_id: entity.knowledge_point_id, knowledge_card_id: entity.knowledge_card_id,
      entity_type: entity.entity_type, entity_id: entity.entity_id,
      provider, model, dimension, title: entity.title, start_ms: entity.start_ms, end_ms: entity.end_ms,
      text: entity.text.slice(0, 1_200), score: Number(score.toFixed(8)), citation: cardCitation ?? knowledgeCitation ?? segmentCitation,
      video_citation: `[VideoDocument:${entity.video_document_id}]`, segment_citation: segmentCitation,
      knowledge_citation: knowledgeCitation, card_citation: cardCitation, structured_card: entity.structured_card,
      artifact_id: entity.knowledge_artifact_id, artifact_name: entity.artifact_name,
      evidence_count: evidence.length,
      evidence_summary: evidence.slice(0, 20).map(item => ({ source_type: item.source_type, source_id: item.source_id, relation_type: item.relation_type })),
      transcript_source: entity.transcript_source, memory_state: entity.memory_state,
      index_state: entity.index_state, fallback_used: fallbackUsed, fallback_reason: fallbackReason,
    }
  }
}
