import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RetrievalBenchmarkMetrics, RetrievalBenchmarkSummary } from '../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { cosineSimilarity, LocalHashEmbeddingProvider, OllamaEmbeddingProvider, type EmbeddingProvider } from '../src/video/embedding.ts'
import { DEFAULT_SEMANTIC_EMBEDDING_MODEL, SemanticRetrievalService } from '../src/retrieval/service.ts'

interface CorpusItem {
  id: string
  entity_type: 'video_segment' | 'knowledge_point'
  document_id: string
  segment_id: string
  knowledge_point_id: string | null
  title: string
  start_ms: number
  end_ms: number
  text: string
  artifact_id: string
  evidence_id: string
}

interface QueryItem {
  id: string
  language: 'zh' | 'en' | 'mixed'
  category: string
  text: string
  relevant_entity_ids: string[]
}

interface BenchmarkFixture {
  schema: string
  frozen_at: string
  top_k: number
  ground_truth_policy: string
  corpus: CorpusItem[]
  queries: QueryItem[]
}

interface QueryRun {
  query_id: string
  text: string
  language: QueryItem['language']
  category: string
  relevant_entity_ids: string[]
  latency_ms: number
  results: Array<{ rank: number; entity_id: string; score: number; segment_id: string; knowledge_point_id: string | null; timestamp_available: boolean; citation_available: boolean }>
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

function metrics(runs: QueryRun[]): RetrievalBenchmarkMetrics {
  const recall = (limit: number): number => runs.filter(run => run.results.slice(0, limit).some(result => run.relevant_entity_ids.includes(result.entity_id))).length / runs.length
  const reciprocal = runs.map(run => {
    const index = run.results.slice(0, 5).findIndex(result => run.relevant_entity_ids.includes(result.entity_id))
    return index < 0 ? 0 : 1 / (index + 1)
  })
  const ndcg = runs.map(run => {
    const dcg = run.results.slice(0, 5).reduce((score, result, index) =>
      score + (run.relevant_entity_ids.includes(result.entity_id) ? 1 / Math.log2(index + 2) : 0), 0)
    const idealCount = Math.min(run.relevant_entity_ids.length, 5)
    const ideal = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2))
      .reduce((sum, value) => sum + value, 0)
    return ideal === 0 ? 0 : dcg / ideal
  })
  const citationHits = runs.filter(run => run.results.slice(0, 5).some(result => run.relevant_entity_ids.includes(result.entity_id) && result.citation_available)).length / runs.length
  const timestampHits = runs.filter(run => run.results.slice(0, 5).some(result => run.relevant_entity_ids.includes(result.entity_id) && result.timestamp_available)).length / runs.length
  const latencies = runs.map(run => run.latency_ms).sort((a, b) => a - b)
  const average = latencies.reduce((sum, value) => sum + value, 0) / latencies.length
  return {
    recall_at_1: Number(recall(1).toFixed(6)), recall_at_3: Number(recall(3).toFixed(6)), recall_at_5: Number(recall(5).toFixed(6)),
    mrr_at_5: Number((reciprocal.reduce((sum, value) => sum + value, 0) / runs.length).toFixed(6)),
    ndcg_at_5: Number((ndcg.reduce((sum, value) => sum + value, 0) / runs.length).toFixed(6)),
    citation_hit_rate_at_5: Number(citationHits.toFixed(6)), timestamp_citation_rate_at_5: Number(timestampHits.toFixed(6)),
    average_query_latency_ms: Number(average.toFixed(3)), p50_query_latency_ms: Number(percentile(latencies, 0.5).toFixed(3)),
    p95_query_latency_ms: Number(percentile(latencies, 0.95).toFixed(3)),
  }
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

async function embedCorpus(provider: EmbeddingProvider, corpus: CorpusItem[]): Promise<{ vectors: number[][]; elapsed_ms: number }> {
  const started = performance.now()
  const vectors: number[][] = []
  for (let offset = 0; offset < corpus.length; offset += 16) {
    const results = await provider.embedBatch(corpus.slice(offset, offset + 16).map(item => item.text))
    vectors.push(...results.map(result => result.vector))
  }
  return { vectors, elapsed_ms: Number((performance.now() - started).toFixed(3)) }
}

async function runQueries(provider: EmbeddingProvider, fixture: BenchmarkFixture, vectors: number[][]): Promise<QueryRun[]> {
  const runs: QueryRun[] = []
  for (const query of fixture.queries) {
    const started = performance.now()
    const queryVector = (await provider.embedText(query.text)).vector
    const ranked = fixture.corpus.map((item, index) => ({ item, score: cosineSimilarity(queryVector, vectors[index]!) }))
      .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
      .slice(0, fixture.top_k)
    runs.push({
      query_id: query.id, text: query.text, language: query.language, category: query.category,
      relevant_entity_ids: query.relevant_entity_ids, latency_ms: Number((performance.now() - started).toFixed(3)),
      results: ranked.map((result, index) => ({
        rank: index + 1, entity_id: result.item.id, score: Number(result.score.toFixed(8)),
        segment_id: result.item.segment_id, knowledge_point_id: result.item.knowledge_point_id,
        timestamp_available: result.item.start_ms >= 0 && result.item.end_ms >= result.item.start_ms,
        citation_available: result.item.segment_id.length > 0 && result.item.artifact_id.length > 0 && result.item.evidence_id.length > 0,
      })),
    })
  }
  return runs
}

const evidenceDirectory = path.resolve(process.argv[2] ?? '')
if (process.argv[2] === undefined) throw new Error('STEP30_EVIDENCE_DIRECTORY_REQUIRED')
await mkdir(evidenceDirectory, { recursive: true })
const fixturePath = path.resolve(import.meta.dirname, '..', 'fixtures', 'step30-retrieval-benchmark.json')
const fixtureBytes = await readFile(fixturePath)
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as BenchmarkFixture
if (fixture.corpus.length < 30 || fixture.queries.length < 20) throw new Error('BENCHMARK_CORPUS_TOO_SMALL')
if (fixture.queries.filter(query => query.language === 'zh').length < 10) throw new Error('BENCHMARK_CHINESE_QUERY_COUNT_TOO_SMALL')
if (new Set(fixture.corpus.map(item => item.id)).size !== fixture.corpus.length) throw new Error('BENCHMARK_DUPLICATE_ENTITY_ID')
for (const query of fixture.queries) {
  if (!query.relevant_entity_ids.every(id => fixture.corpus.some(item => item.id === id))) throw new Error(`BENCHMARK_GROUND_TRUTH_NOT_FOUND: ${query.id}`)
}
await writeFile(path.join(evidenceDirectory, 'retrieval-benchmark.json'), fixtureBytes)

const localProvider = new LocalHashEmbeddingProvider(256)
const semanticProvider = new OllamaEmbeddingProvider('http://127.0.0.1:11434', DEFAULT_SEMANTIC_EMBEDDING_MODEL, 180_000)
const memoryBefore = process.memoryUsage().rss
const cpuBefore = process.cpuUsage()
const vramBefore = gpuMemoryUsed()
const modelLoadStarted = performance.now()
const semanticHealth = await semanticProvider.health()
const modelLoadMs = Number((performance.now() - modelLoadStarted).toFixed(3))
if (!semanticHealth.available) throw new Error(`SEMANTIC_MODEL_UNAVAILABLE: ${semanticHealth.diagnostic}`)
const vramAfterLoad = gpuMemoryUsed()

const localCorpus = await embedCorpus(localProvider, fixture.corpus)
const baselineRuns = await runQueries(localProvider, fixture, localCorpus.vectors)
const semanticCorpus = await embedCorpus(semanticProvider, fixture.corpus)
const semanticRuns = await runQueries(semanticProvider, fixture, semanticCorpus.vectors)
const vramAfterBenchmark = gpuMemoryUsed()
const cpuUsed = process.cpuUsage(cpuBefore)
const baselineMetrics = metrics(baselineRuns)
const semanticMetrics = metrics(semanticRuns)
const chineseBaseline = metrics(baselineRuns.filter(run => run.language === 'zh'))
const chineseSemantic = metrics(semanticRuns.filter(run => run.language === 'zh'))
const semanticDimension = semanticCorpus.vectors[0]!.length
const selectedDefault = semanticMetrics.recall_at_3 >= baselineMetrics.recall_at_3
  && semanticMetrics.mrr_at_5 >= baselineMetrics.mrr_at_5
  && chineseSemantic.mrr_at_5 > chineseBaseline.mrr_at_5
  && semanticMetrics.citation_hit_rate_at_5 >= baselineMetrics.citation_hit_rate_at_5
  && semanticMetrics.average_query_latency_ms < 5_000
    ? 'semantic' : 'local-hash-v1'
const createdAt = new Date().toISOString()
const peakValues = [vramBefore, vramAfterLoad, vramAfterBenchmark].filter((value): value is number => value !== null)
const summary: RetrievalBenchmarkSummary = {
  created_at: createdAt, corpus_size: fixture.corpus.length, query_count: fixture.queries.length,
  chinese_query_count: fixture.queries.filter(query => query.language === 'zh').length,
  selected_default: selectedDefault, semantic_model: DEFAULT_SEMANTIC_EMBEDDING_MODEL,
  baseline: baselineMetrics, semantic: semanticMetrics, chinese_baseline: chineseBaseline, chinese_semantic: chineseSemantic,
  semantic_index_build_ms: semanticCorpus.elapsed_ms,
  semantic_embedding_texts_per_second: Number((fixture.corpus.length / (semanticCorpus.elapsed_ms / 1000)).toFixed(3)),
  semantic_vector_storage_bytes: fixture.corpus.length * semanticDimension * 4,
  model_load_ms: modelLoadMs, peak_vram_mb: peakValues.length === 0 ? null : Math.max(...peakValues),
}
const results = {
  schema: 'personal-workbench.retrieval-benchmark-results.v1',
  created_at: createdAt,
  fixture_path: fixturePath,
  fixture_sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  ground_truth_frozen_at: fixture.frozen_at,
  corpus_size: fixture.corpus.length,
  query_count: fixture.queries.length,
  top_k: fixture.top_k,
  providers: {
    baseline: { provider: 'local-hash-v1', model: 'unicode-ngram-sha256', dimension: 256, index_build_ms: localCorpus.elapsed_ms, metrics: baselineMetrics, queries: baselineRuns },
    semantic: { provider: 'ollama', model: DEFAULT_SEMANTIC_EMBEDDING_MODEL, dimension: semanticDimension, index_build_ms: semanticCorpus.elapsed_ms, model_load_ms: modelLoadMs, health: semanticHealth, metrics: semanticMetrics, queries: semanticRuns },
  },
  chinese_comparison: { baseline: chineseBaseline, semantic: chineseSemantic },
  selection: {
    selected_default: selectedDefault,
    checks: {
      recall_at_3_not_lower: semanticMetrics.recall_at_3 >= baselineMetrics.recall_at_3,
      mrr_at_5_not_lower: semanticMetrics.mrr_at_5 >= baselineMetrics.mrr_at_5,
      chinese_mrr_improved: chineseSemantic.mrr_at_5 > chineseBaseline.mrr_at_5,
      citation_hit_rate_not_lower: semanticMetrics.citation_hit_rate_at_5 >= baselineMetrics.citation_hit_rate_at_5,
      latency_under_5000_ms: semanticMetrics.average_query_latency_ms < 5_000,
    },
  },
  resources: {
    cpu_model: os.cpus()[0]?.model ?? null,
    logical_processors: os.cpus().length,
    process_cpu_user_microseconds: cpuUsed.user,
    process_cpu_system_microseconds: cpuUsed.system,
    process_rss_before_bytes: memoryBefore,
    process_rss_after_bytes: process.memoryUsage().rss,
    vram_before_mb: vramBefore,
    vram_after_model_load_mb: vramAfterLoad,
    vram_after_benchmark_mb: vramAfterBenchmark,
    ollama_ps: command('ollama', ['ps']),
  },
  summary,
}
await writeFile(path.join(evidenceDirectory, 'retrieval-benchmark-results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8')
await writeFile(path.join(evidenceDirectory, 'performance.json'), `${JSON.stringify({
  created_at: createdAt,
  local_index_build_ms: localCorpus.elapsed_ms,
  semantic_index_build_ms: semanticCorpus.elapsed_ms,
  model_load_ms: modelLoadMs,
  local_average_query_ms: baselineMetrics.average_query_latency_ms,
  semantic_average_query_ms: semanticMetrics.average_query_latency_ms,
  semantic_texts_per_second: summary.semantic_embedding_texts_per_second,
  embedding_batch_size: 16,
  semantic_vector_storage_bytes: summary.semantic_vector_storage_bytes,
  cpu: {
    model: os.cpus()[0]?.model ?? null,
    logical_processors: os.cpus().length,
    process_user_microseconds: cpuUsed.user,
    process_system_microseconds: cpuUsed.system,
  },
  process_rss_before_bytes: memoryBefore,
  process_rss_after_bytes: process.memoryUsage().rss,
  vram_samples_mb: { before: vramBefore, after_load: vramAfterLoad, after_benchmark: vramAfterBenchmark },
}, null, 2)}\n`, 'utf8')
const database = new WorkbenchDatabase()
const retrieval = new SemanticRetrievalService(database)
retrieval.saveBenchmark(summary)
database.close()
process.stdout.write(`${JSON.stringify({ summary, output: path.join(evidenceDirectory, 'retrieval-benchmark-results.json') }, null, 2)}\n`)
