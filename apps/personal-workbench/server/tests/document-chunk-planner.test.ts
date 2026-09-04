import { describe, expect, it } from 'vitest'
import { planDocumentChunks } from '../src/documents/chunk-planner.ts'

describe('STEP-35 DocumentChunkPlanner', () => {
  it('keeps source anchors while limiting a local-model input size', () => {
    const chunks = planDocumentChunks([
      { heading: '第一章', level: 1, text: '甲'.repeat(800), source_anchor: 'page:1' },
      { heading: '第二章', level: 1, text: '乙'.repeat(800), source_anchor: 'page:2' },
      { heading: '第三章', level: 1, text: '丙'.repeat(2_500), source_anchor: 'page:3' },
    ], 1_000)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every(chunk => chunk.char_count <= 1_000)).toBe(true)
    expect(chunks.flatMap(chunk => chunk.anchors)).toContain('page:1')
    expect(chunks.flatMap(chunk => chunk.anchors).some(anchor => anchor.startsWith('page:3#part-'))).toBe(true)
  })
})
