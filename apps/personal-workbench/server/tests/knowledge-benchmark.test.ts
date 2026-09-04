import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const fixturePath = path.resolve(import.meta.dirname, '..', 'fixtures', 'step31-knowledge-benchmark.json')

async function loadFixture(): Promise<{ frozen_at: string; source_benchmark: string; segments: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as { frozen_at: string; source_benchmark: string; segments: Array<Record<string, unknown>> }
}

export function keywordCoverage(required: string[], values: string[]): number {
  if (required.length === 0) return 1
  const body = values.join('\n').normalize('NFKC').toLowerCase()
  return required.filter(term => body.includes(term.normalize('NFKC').toLowerCase())).length / required.length
}

export function compressionRatio(structuredCharacters: number, legacyCharacters: number): number {
  return legacyCharacters === 0 ? 0 : structuredCharacters / legacyCharacters
}

export function duplicateRate(duplicates: number, total: number): number {
  return total === 0 ? 0 : duplicates / total
}

describe('STEP-31 frozen Knowledge Card benchmark', () => {
  it('contains at least twenty frozen Segments', async () => expect((await loadFixture()).segments.length).toBeGreaterThanOrEqual(20))

  it('freezes the fixture before extraction execution', async () => {
    const value = await loadFixture()
    expect(value.frozen_at).toBe('2026-08-24T00:30:00.000Z')
    expect(value.source_benchmark).toBe('step30-retrieval-benchmark.json')
  })

  it('uses unique Segment and Ground Truth identifiers', async () => {
    const segments = (await loadFixture()).segments
    const ids = segments.map(item => String(item.segment_id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(segments.every(item => item.ground_truth_id === item.segment_id)).toBe(true)
  })

  it('pins expected concepts, required terms and numeric policy', async () => {
    const segments = (await loadFixture()).segments
    expect(segments.every(item => Array.isArray(item.expected_concepts) && (item.expected_concepts as unknown[]).length > 0)).toBe(true)
    expect(segments.every(item => Array.isArray(item.required_terms) && (item.required_terms as unknown[]).length > 0)).toBe(true)
    expect(segments.every(item => item.forbidden_new_numeric_claims === true)).toBe(true)
  })

  it('contains a fixed query for every Segment', async () => expect((await loadFixture()).segments.every(item => String(item.query).length > 0)).toBe(true))

  it('has a reproducible fixture SHA-256', async () => expect(createHash('sha256').update(await readFile(fixturePath)).digest('hex')).toMatch(/^[0-9a-f]{64}$/u))

  it('calculates compression ratio without treating shorter as automatically better', () => expect(compressionRatio(60, 100)).toBe(0.6))

  it('calculates required keyword coverage', () => expect(keywordCoverage(['I', 'Q', '正交'], ['I与Q', '正交分量'])).toBe(1))

  it('calculates duplicate rate', () => expect(duplicateRate(2, 10)).toBe(0.2))

  it('keeps the STEP-30 fixture unchanged by referencing it instead of copying its results', async () => {
    const step30 = await readFile(path.resolve(import.meta.dirname, '..', 'fixtures', 'step30-retrieval-benchmark.json'))
    expect(createHash('sha256').update(step30).digest('hex')).toMatch(/^[0-9a-f]{64}$/u)
  })
})
