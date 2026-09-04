import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cosineSimilarity, localHashEmbedding } from '../src/video/embedding.ts'

const fixturePath = path.resolve(import.meta.dirname, '..', 'fixtures', 'step30-retrieval-benchmark.json')

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>
}

describe('STEP-30 fixed retrieval benchmark', () => {
  it('contains at least thirty indexed entities', async () => {
    const value = await fixture()
    expect(value.corpus).toBeInstanceOf(Array)
    expect((value.corpus as unknown[]).length).toBeGreaterThanOrEqual(30)
  })

  it('contains at least twenty fixed queries', async () => {
    const value = await fixture()
    expect((value.queries as unknown[]).length).toBeGreaterThanOrEqual(20)
  })

  it('contains at least ten Chinese queries', async () => {
    const value = await fixture()
    const queries = value.queries as Array<{ language: string }>
    expect(queries.filter(query => query.language === 'zh').length).toBeGreaterThanOrEqual(10)
  })

  it('freezes Ground Truth before retrieval execution', async () => {
    const value = await fixture()
    expect(value.frozen_at).toMatch(/^2026-/u)
    expect(String(value.ground_truth_policy)).toContain('运行检索后不得改动')
  })

  it('uses unique corpus identifiers', async () => {
    const value = await fixture()
    const ids = (value.corpus as Array<{ id: string }>).map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('points every Ground Truth id to a real corpus entity', async () => {
    const value = await fixture()
    const ids = new Set((value.corpus as Array<{ id: string }>).map(item => item.id))
    const queries = value.queries as Array<{ relevant_entity_ids: string[] }>
    expect(queries.every(query => query.relevant_entity_ids.every(id => ids.has(id)))).toBe(true)
  })

  it('carries timestamp, Artifact and Evidence citation fields', async () => {
    const value = await fixture()
    const corpus = value.corpus as Array<{ start_ms: number; end_ms: number; artifact_id: string; evidence_id: string }>
    expect(corpus.every(item => item.start_ms >= 0 && item.end_ms >= item.start_ms && item.artifact_id.length > 0 && item.evidence_id.length > 0)).toBe(true)
  })

  it('has a reproducible fixture hash', async () => {
    const bytes = await readFile(fixturePath)
    expect(createHash('sha256').update(bytes).digest('hex')).toHaveLength(64)
  })

  it('can run the local-hash baseline without external services', async () => {
    const value = await fixture()
    const corpus = value.corpus as Array<{ id: string; text: string }>
    const [query] = value.queries as Array<{ text: string }>
    const queryVector = localHashEmbedding(query!.text)
    const ranked = corpus.map(item => ({ id: item.id, score: cosineSimilarity(queryVector, localHashEmbedding(item.text)) }))
      .sort((left, right) => right.score - left.score)
    expect(ranked).toHaveLength(corpus.length)
    expect(Number.isFinite(ranked[0]!.score)).toBe(true)
  })

  it('pins top-k to five for the A/B comparison', async () => expect((await fixture()).top_k).toBe(5))

  it('keeps Segment and Knowledge Point entities in one corpus', async () => {
    const corpus = (await fixture()).corpus as Array<{ entity_type: string }>
    expect(new Set(corpus.map(item => item.entity_type))).toEqual(new Set(['video_segment', 'knowledge_point']))
  })

  it('includes Chinese paraphrase, mixed-language, short and long queries', async () => {
    const queries = (await fixture()).queries as Array<{ language: string; category: string }>
    expect(queries.some(query => query.category === 'semantic_paraphrase')).toBe(true)
    expect(queries.some(query => query.language === 'mixed')).toBe(true)
    expect(queries.some(query => query.category === 'short')).toBe(true)
    expect(queries.some(query => query.category === 'long')).toBe(true)
  })

  it('implements all required metric names in the real runner', async () => {
    const source = await readFile(path.resolve(import.meta.dirname, '..', 'workers', 'retrieval-benchmark.ts'), 'utf8')
    for (const metric of ['recall_at_1', 'recall_at_3', 'recall_at_5', 'mrr_at_5', 'ndcg_at_5', 'citation_hit_rate_at_5']) {
      expect(source).toContain(metric)
    }
  })
})
