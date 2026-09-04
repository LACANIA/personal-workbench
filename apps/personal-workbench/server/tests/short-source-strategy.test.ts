import { describe, expect, it } from 'vitest'
import { createCompactLearningContent, decideDocumentStrategy } from '../src/documents/short-source-strategy.ts'

describe('STEP-36 ShortSourceStrategy', () => {
  it('uses extracted content and structure instead of file size', () => {
    expect(decideDocumentStrategy('牛顿第二定律说明合力、质量和加速度之间的关系。', { section_count: 1, page_or_slide_count: 1 }).mode).toBe('short')
    expect(decideDocumentStrategy('内容。'.repeat(16_000), { section_count: 12, page_or_slide_count: 40 }).mode).toBe('hierarchical')
    expect(decideDocumentStrategy('内容。'.repeat(1_000), { section_count: 4, page_or_slide_count: 4 }).mode).toBe('standard')
  })

  it('creates an anchored compact document without inventing technical claims', () => {
    const content = createCompactLearningContent({
      source_type: 'local_file', source_title: '牛顿第二定律', source_reference: '本机资料', source_text: '力会引起加速度。质量会影响加速度大小。',
      source_references: [{ label: '牛顿第二定律', reference: '本机资料', time_range: 'Slide 1' }], source_artifact_ids: [], timestamp_refs: [], card_summaries: [], legacy_summaries: [], formula_evidence: [],
    })
    expect(content.sections[0]?.source_refs).toEqual(['Slide 1'])
    expect(content.key_points.join('')).toContain('加速度')
    expect(content.key_points.join('')).not.toContain('重力')
  })
})
