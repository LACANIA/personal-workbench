import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { KnowledgeBenchmarkSummary, RetrievalBenchmarkMetrics } from '../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { cardEmbeddingText, KNOWLEDGE_CARD_DUPLICATE_THRESHOLD } from '../src/knowledge/dedup.ts'
import {
  KNOWLEDGE_EXTRACTION_PROMPT_SHA256,
  KNOWLEDGE_EXTRACTION_PROMPT_VERSION,
  KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
  Qwen3KnowledgeExtractionProvider,
  type ExtractedKnowledgeCard,
} from '../src/knowledge/extraction.ts'
import { GroundingValidator } from '../src/knowledge/grounding.ts'
import { KnowledgeCardRepository } from '../src/knowledge/repository.ts'
import { DEFAULT_SEMANTIC_EMBEDDING_MODEL } from '../src/retrieval/service.ts'
import { cosineSimilarity, OllamaEmbeddingProvider } from '../src/video/embedding.ts'

interface BenchmarkSegment {
  segment_id: string
  start_ms: number
  end_ms: number
  source_text: string
  legacy_text: string
  expected_concepts: string[]
  required_terms: string[]
  forbidden_new_numeric_claims: boolean
  query: string
  ground_truth_id: string
}

interface BenchmarkFixture {
  schema: string
  frozen_at: string
  source_benchmark: string
  policy: string
  segments: BenchmarkSegment[]
}

interface CardItem {
  id: string
  segment_id: string
  start_ms: number
  end_ms: number
  card: ExtractedKnowledgeCard
  text: string
  characters: number
  grounding_valid: boolean
  grounding_issues: string[]
  citation: string
}

interface QueryRun {
  query_id: string
  query: string
  relevant_ids: string[]
  latency_ms: number
  results: Array<{ rank: number; id: string; segment_id: string; score: number; citation_available: boolean; timestamp_available: boolean }>
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function codepointLength(value: string): number {
  return [...value].length
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function rounded(value: number, digits = 6): number {
  return Number(value.toFixed(digits))
}

function command(name: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(name, args, { encoding: 'utf8', shell: false, windowsHide: true })
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

function gpuMemoryUsed(): number | null {
  const result = command('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'])
  const value = Number(result.stdout.split(/\r?\n/u)[0])
  return Number.isFinite(value) ? value : null
}

function retrievalMetrics(runs: QueryRun[]): RetrievalBenchmarkMetrics {
  const recall = (limit: number): number => runs.filter(run => run.results.slice(0, limit).some(result => run.relevant_ids.includes(result.id))).length / runs.length
  const reciprocalRanks = runs.map(run => {
    const index = run.results.slice(0, 5).findIndex(result => run.relevant_ids.includes(result.id))
    return index < 0 ? 0 : 1 / (index + 1)
  })
  const normalizedGains = runs.map(run => {
    const actual = run.results.slice(0, 5).reduce((score, result, index) => score + (run.relevant_ids.includes(result.id) ? 1 / Math.log2(index + 2) : 0), 0)
    const idealCount = Math.min(run.relevant_ids.length, 5)
    const ideal = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0)
    return ideal === 0 ? 0 : actual / ideal
  })
  const citationHits = runs.filter(run => run.results.slice(0, 5).some(result => run.relevant_ids.includes(result.id) && result.citation_available)).length / runs.length
  const timestampHits = runs.filter(run => run.results.slice(0, 5).some(result => run.relevant_ids.includes(result.id) && result.timestamp_available)).length / runs.length
  const latencies = runs.map(run => run.latency_ms)
  return {
    recall_at_1: rounded(recall(1)), recall_at_3: rounded(recall(3)), recall_at_5: rounded(recall(5)),
    mrr_at_5: rounded(mean(reciprocalRanks)), ndcg_at_5: rounded(mean(normalizedGains)),
    citation_hit_rate_at_5: rounded(citationHits), timestamp_citation_rate_at_5: rounded(timestampHits),
    average_query_latency_ms: rounded(mean(latencies), 3), p50_query_latency_ms: rounded(percentile(latencies, 0.5), 3),
    p95_query_latency_ms: rounded(percentile(latencies, 0.95), 3),
  }
}

async function embedInBatches(provider: OllamaEmbeddingProvider, values: string[]): Promise<{ vectors: number[][]; elapsed_ms: number }> {
  const started = performance.now()
  const vectors: number[][] = []
  for (let offset = 0; offset < values.length; offset += 16) {
    const result = await provider.embedBatch(values.slice(offset, offset + 16))
    vectors.push(...result.map(item => item.vector))
  }
  return { vectors, elapsed_ms: rounded(performance.now() - started, 3) }
}

async function rankLegacy(provider: OllamaEmbeddingProvider, fixture: BenchmarkFixture, vectors: number[][]): Promise<QueryRun[]> {
  const output: QueryRun[] = []
  for (const segment of fixture.segments) {
    const started = performance.now()
    const query = (await provider.embedText(segment.query)).vector
    const results = fixture.segments.map((candidate, index) => ({ candidate, score: cosineSimilarity(query, vectors[index]!) }))
      .sort((left, right) => right.score - left.score || left.candidate.segment_id.localeCompare(right.candidate.segment_id))
      .slice(0, 5)
      .map((item, index) => ({
        rank: index + 1, id: item.candidate.segment_id, segment_id: item.candidate.segment_id, score: rounded(item.score, 8),
        citation_available: true, timestamp_available: item.candidate.end_ms >= item.candidate.start_ms,
      }))
    output.push({
      query_id: `query-${segment.segment_id}`, query: segment.query, relevant_ids: [segment.ground_truth_id],
      latency_ms: rounded(performance.now() - started, 3), results,
    })
  }
  return output
}

async function rankStructured(provider: OllamaEmbeddingProvider, fixture: BenchmarkFixture, cards: CardItem[], vectors: number[][]): Promise<QueryRun[]> {
  const output: QueryRun[] = []
  for (const segment of fixture.segments) {
    const started = performance.now()
    const query = (await provider.embedText(segment.query)).vector
    const relevantIds = cards.filter(card => card.segment_id === segment.ground_truth_id).map(card => card.id)
    const results = cards.map((candidate, index) => ({ candidate, score: cosineSimilarity(query, vectors[index]!) }))
      .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
      .slice(0, 5)
      .map((item, index) => ({
        rank: index + 1, id: item.candidate.id, segment_id: item.candidate.segment_id, score: rounded(item.score, 8),
        citation_available: item.candidate.citation.length > 0,
        timestamp_available: item.candidate.end_ms >= item.candidate.start_ms,
      }))
    output.push({
      query_id: `query-${segment.segment_id}`, query: segment.query, relevant_ids: relevantIds,
      latency_ms: rounded(performance.now() - started, 3), results,
    })
  }
  return output
}

const evidenceDirectory = path.resolve(process.argv[2] ?? '')
if (process.argv[2] === undefined) throw new Error('STEP31_EVIDENCE_DIRECTORY_REQUIRED')
await mkdir(evidenceDirectory, { recursive: true })
const fixturePath = path.resolve(import.meta.dirname, '..', 'fixtures', 'step31-knowledge-benchmark.json')
const fixtureBytes = await readFile(fixturePath)
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as BenchmarkFixture
if (fixture.segments.length < 20) throw new Error('KNOWLEDGE_BENCHMARK_TOO_SMALL')
if (new Set(fixture.segments.map(item => item.segment_id)).size !== fixture.segments.length) throw new Error('KNOWLEDGE_BENCHMARK_DUPLICATE_SEGMENT')
for (const item of fixture.segments) {
  if (item.ground_truth_id !== item.segment_id) throw new Error(`KNOWLEDGE_BENCHMARK_GROUND_TRUTH_INVALID:${item.segment_id}`)
}
await writeFile(path.join(evidenceDirectory, 'knowledge-benchmark.json'), fixtureBytes)

const extractor = new Qwen3KnowledgeExtractionProvider()
const embedding = new OllamaEmbeddingProvider('http://127.0.0.1:11434', DEFAULT_SEMANTIC_EMBEDDING_MODEL, 180_000)
const grounding = new GroundingValidator()
const extractionHealth = await extractor.health()
const embeddingHealthBefore = await embedding.health()
if (!extractionHealth.available) throw new Error(`KNOWLEDGE_EXTRACTOR_UNAVAILABLE:${extractionHealth.diagnostic}`)
if (!embeddingHealthBefore.available) throw new Error(`KNOWLEDGE_EMBEDDING_UNAVAILABLE:${embeddingHealthBefore.diagnostic}`)

await writeFile(path.join(evidenceDirectory, 'knowledge-prompt.json'), `${JSON.stringify({
  schema: 'personal-workbench.knowledge-prompt-evidence.v1',
  prompt_version: KNOWLEDGE_EXTRACTION_PROMPT_VERSION,
  prompt_sha256: KNOWLEDGE_EXTRACTION_PROMPT_SHA256,
  system_prompt: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
  provider: extractor.metadata(),
}, null, 2)}\n`, 'utf8')

const processStarted = performance.now()
const rssBefore = process.memoryUsage().rss
const vramSamples: Array<{ phase: string; used_mb: number | null }> = [{ phase: 'before', used_mb: gpuMemoryUsed() }]
const legacyEmbedding = await embedInBatches(embedding, fixture.segments.map(item => item.legacy_text))
vramSamples.push({ phase: 'after_legacy_embedding', used_mb: gpuMemoryUsed() })

const extracted: Array<{
  segment_id: string
  success: boolean
  error: string | null
  cards: CardItem[]
  duration_ms: number
  prompt_tokens: number
  output_tokens: number
  repair_count: number
  keyword_coverage: number
}> = []
const cards: CardItem[] = []

for (let index = 0; index < fixture.segments.length; index += 1) {
  const item = fixture.segments[index]!
  try {
    const response = await extractor.extract(
      { id: item.segment_id, text: item.source_text, start_ms: item.start_ms, end_ms: item.end_ms },
      { video_title: item.source_text.slice(0, 30) },
    )
    const segmentCards = response.cards.map((card, cardIndex): CardItem => {
      const validation = grounding.validate(card, item.source_text)
      const id = `${item.segment_id}:card:${cardIndex + 1}`
      const text = cardEmbeddingText(card)
      return {
        id, segment_id: item.segment_id, start_ms: item.start_ms, end_ms: item.end_ms, card, text,
        characters: codepointLength([card.title, card.concept, card.core_claim, card.explanation, card.keywords.join('')].join('')),
        grounding_valid: validation.valid, grounding_issues: validation.issues,
        citation: `[KnowledgeCard:${id} VideoSegment:${item.segment_id} ${item.start_ms}-${item.end_ms}ms]`,
      }
    })
    cards.push(...segmentCards)
    const cardText = segmentCards.map(card => card.text).join('\n').normalize('NFKC').toLocaleLowerCase('en-US')
    const covered = item.required_terms.filter(term => cardText.includes(term.normalize('NFKC').toLocaleLowerCase('en-US'))).length
    extracted.push({
      segment_id: item.segment_id, success: true, error: null, cards: segmentCards,
      duration_ms: response.metrics.duration_ms, prompt_tokens: response.metrics.prompt_tokens,
      output_tokens: response.metrics.output_tokens, repair_count: response.metrics.repair_count,
      keyword_coverage: covered / item.required_terms.length,
    })
  } catch (error) {
    extracted.push({
      segment_id: item.segment_id, success: false, error: error instanceof Error ? error.message : String(error), cards: [],
      duration_ms: 0, prompt_tokens: 0, output_tokens: 0, repair_count: 0, keyword_coverage: 0,
    })
  }
  await writeFile(path.join(evidenceDirectory, 'knowledge-benchmark-checkpoint.json'), `${JSON.stringify({
    schema: 'personal-workbench.knowledge-benchmark-checkpoint.v1',
    completed_segments: index + 1,
    total_segments: fixture.segments.length,
    successful_segments: extracted.filter(item => item.success).length,
    cards: cards.length,
    latest_segment: item.segment_id,
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
}
vramSamples.push({ phase: 'after_extraction', used_mb: gpuMemoryUsed() })

if (cards.length === 0) throw new Error('KNOWLEDGE_BENCHMARK_NO_CARDS')
const structuredEmbedding = await embedInBatches(embedding, cards.map(card => card.text))
vramSamples.push({ phase: 'after_structured_embedding', used_mb: gpuMemoryUsed() })
const embeddingHealthAfter = await embedding.health()

const legacyRuns = await rankLegacy(embedding, fixture, legacyEmbedding.vectors)
const structuredRuns = await rankStructured(embedding, fixture, cards, structuredEmbedding.vectors)
const legacyMetrics = retrievalMetrics(legacyRuns)
const structuredMetrics = retrievalMetrics(structuredRuns)

const legacyCharacters = fixture.segments.map(item => codepointLength(item.legacy_text))
const structuredCharactersPerSegment = fixture.segments.map(item => cards.filter(card => card.segment_id === item.segment_id).reduce((sum, card) => sum + card.characters, 0))
const duplicateCardIds = new Set<string>()
for (let left = 0; left < cards.length; left += 1) {
  for (let right = 0; right < left; right += 1) {
    if (cosineSimilarity(structuredEmbedding.vectors[left]!, structuredEmbedding.vectors[right]!) >= KNOWLEDGE_CARD_DUPLICATE_THRESHOLD) {
      duplicateCardIds.add(cards[left]!.id)
      break
    }
  }
}
const legacyDuplicateIds = new Set<string>()
for (let left = 0; left < fixture.segments.length; left += 1) {
  for (let right = 0; right < left; right += 1) {
    if (cosineSimilarity(legacyEmbedding.vectors[left]!, legacyEmbedding.vectors[right]!) >= KNOWLEDGE_CARD_DUPLICATE_THRESHOLD) {
      legacyDuplicateIds.add(fixture.segments[left]!.segment_id)
      break
    }
  }
}

const extractionLatencies = extracted.filter(item => item.success).map(item => item.duration_ms)
const schemaValidRate = extracted.filter(item => item.success).length / fixture.segments.length
const sourceLinkRate = cards.filter(card => card.segment_id.length > 0 && card.end_ms >= card.start_ms).length / cards.length
const numericGroundingRate = cards.filter(card => card.grounding_valid).length / cards.length
const keywordCoverage = mean(extracted.map(item => item.keyword_coverage))
const legacyAverageCharacters = mean(legacyCharacters)
const structuredAverageCharacters = mean(cards.map(card => card.characters))
const compressionRatio = structuredCharactersPerSegment.reduce((sum, value) => sum + value, 0) / legacyCharacters.reduce((sum, value) => sum + value, 0)
const legacyDuplicateRate = legacyDuplicateIds.size / fixture.segments.length
const structuredDuplicateRate = duplicateCardIds.size / cards.length
const selectionChecks = {
  schema_valid_at_least_98_percent: schemaValidRate >= 0.98,
  source_link_complete: sourceLinkRate === 1,
  numeric_grounding_not_lower: numericGroundingRate >= 0.98,
  recall_at_3_not_lower: structuredMetrics.recall_at_3 >= legacyMetrics.recall_at_3,
  mrr_at_5_within_tolerance: structuredMetrics.mrr_at_5 + 0.01 >= legacyMetrics.mrr_at_5,
  citation_hit_not_lower: structuredMetrics.citation_hit_rate_at_5 >= legacyMetrics.citation_hit_rate_at_5,
  average_display_length_lower: structuredAverageCharacters < legacyAverageCharacters,
  duplicate_rate_not_higher: structuredDuplicateRate <= legacyDuplicateRate,
}
const selectedDefault: 'legacy' | 'structured' = Object.values(selectionChecks).every(Boolean) ? 'structured' : 'legacy'
const createdAt = new Date().toISOString()
const summary: KnowledgeBenchmarkSummary = {
  created_at: createdAt, corpus_size: fixture.segments.length,
  schema_valid_rate: rounded(schemaValidRate), source_link_rate: rounded(sourceLinkRate),
  numeric_grounding_pass_rate: rounded(numericGroundingRate), keyword_coverage: rounded(keywordCoverage),
  legacy_average_characters: rounded(legacyAverageCharacters, 3), structured_average_characters: rounded(structuredAverageCharacters, 3),
  compression_ratio: rounded(compressionRatio), cards_per_segment: rounded(cards.length / fixture.segments.length, 3),
  legacy_duplicate_rate: rounded(legacyDuplicateRate), structured_duplicate_rate: rounded(structuredDuplicateRate),
  legacy_retrieval: legacyMetrics, structured_retrieval: structuredMetrics, selected_default: selectedDefault,
  extractor_model: extractor.metadata().model, embedding_model: DEFAULT_SEMANTIC_EMBEDDING_MODEL,
  total_extraction_ms: rounded(extractionLatencies.reduce((sum, value) => sum + value, 0), 3),
  p50_extraction_ms: rounded(percentile(extractionLatencies, 0.5), 3), p95_extraction_ms: rounded(percentile(extractionLatencies, 0.95), 3),
}

const results = {
  schema: 'personal-workbench.knowledge-benchmark-results.v1', created_at: createdAt,
  fixture: { path: fixturePath, sha256: sha256(fixtureBytes), frozen_at: fixture.frozen_at, source_benchmark: fixture.source_benchmark },
  frozen_variables: {
    asr: true, segment_algorithm: true, embedding_provider: 'ollama_embedding', embedding_model: DEFAULT_SEMANTIC_EMBEDDING_MODEL,
    embedding_dimension: structuredEmbedding.vectors[0]?.length ?? null, retrieval_algorithm: 'node_cosine_similarity',
    artifact_evidence: true, review_gate: true,
  },
  extraction: {
    provider: extractor.metadata(), attempted_segments: fixture.segments.length,
    successful_segments: extracted.filter(item => item.success).length, failed_segments: extracted.filter(item => !item.success),
    cards: cards.length, records: extracted,
  },
  quality: {
    schema_valid_rate: rounded(schemaValidRate), source_link_rate: rounded(sourceLinkRate),
    numeric_grounding_pass_rate: rounded(numericGroundingRate), keyword_coverage: rounded(keywordCoverage),
    legacy_average_characters: rounded(legacyAverageCharacters, 3), structured_average_card_characters: rounded(structuredAverageCharacters, 3),
    structured_characters_per_segment: rounded(mean(structuredCharactersPerSegment), 3), compression_ratio: rounded(compressionRatio),
    cards_per_segment: rounded(cards.length / fixture.segments.length, 3),
    legacy_duplicate_rate: rounded(legacyDuplicateRate), structured_duplicate_rate: rounded(structuredDuplicateRate),
    duplicate_threshold: KNOWLEDGE_CARD_DUPLICATE_THRESHOLD, duplicate_card_ids: [...duplicateCardIds],
  },
  retrieval: {
    legacy: { corpus_count: fixture.segments.length, metrics: legacyMetrics, queries: legacyRuns },
    structured: { corpus_count: cards.length, metrics: structuredMetrics, queries: structuredRuns },
  },
  selection: { selected_default: selectedDefault, checks: selectionChecks },
  summary,
}

await writeFile(path.join(evidenceDirectory, 'knowledge-benchmark-results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8')
await writeFile(path.join(evidenceDirectory, 'retrieval-comparison.json'), `${JSON.stringify({
  schema: 'personal-workbench.step31-retrieval-comparison.v1', created_at: createdAt,
  embedding_model: DEFAULT_SEMANTIC_EMBEDDING_MODEL, embedding_dimension: structuredEmbedding.vectors[0]?.length ?? null,
  legacy: { metrics: legacyMetrics, queries: legacyRuns }, structured: { metrics: structuredMetrics, queries: structuredRuns },
  selection: { selected_default: selectedDefault, checks: selectionChecks },
}, null, 2)}\n`, 'utf8')
const performanceEvidence = {
  schema: 'personal-workbench.step31-performance.v1', created_at: createdAt,
  total_worker_ms: rounded(performance.now() - processStarted, 3), total_extraction_ms: summary.total_extraction_ms,
  extraction_latency_ms: { average: rounded(mean(extractionLatencies), 3), p50: summary.p50_extraction_ms, p95: summary.p95_extraction_ms },
  tokens: {
    input: extracted.reduce((sum, item) => sum + item.prompt_tokens, 0),
    output: extracted.reduce((sum, item) => sum + item.output_tokens, 0),
  },
  embedding: {
    model: DEFAULT_SEMANTIC_EMBEDDING_MODEL, dimension: structuredEmbedding.vectors[0]?.length ?? null,
    legacy_index_ms: legacyEmbedding.elapsed_ms, structured_index_ms: structuredEmbedding.elapsed_ms,
    switch_sequence: ['embedding', 'qwen3_extraction', 'embedding'], health_before: embeddingHealthBefore, health_after: embeddingHealthAfter,
  },
  resources: {
    cpu_model: os.cpus()[0]?.model ?? null, logical_processors: os.cpus().length,
    rss_before_bytes: rssBefore, rss_after_bytes: process.memoryUsage().rss, vram_samples_mb: vramSamples,
    ollama_ps: command('ollama', ['ps']),
  },
}
await writeFile(path.join(evidenceDirectory, 'performance.json'), `${JSON.stringify(performanceEvidence, null, 2)}\n`, 'utf8')

const database = new WorkbenchDatabase()
new KnowledgeCardRepository(database).saveBenchmark(summary)
const integrity = database.db.prepare('PRAGMA integrity_check').all()
const foreignKeys = database.db.prepare('PRAGMA foreign_key_check').all()
database.close()
await writeFile(path.join(evidenceDirectory, 'knowledge-benchmark-db-validation.json'), `${JSON.stringify({ integrity, foreign_keys: foreignKeys }, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ summary, selection_checks: selectionChecks, output: path.join(evidenceDirectory, 'knowledge-benchmark-results.json') }, null, 2)}\n`)
