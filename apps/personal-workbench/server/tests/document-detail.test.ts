import { describe, expect, it } from 'vitest'

describe('STEP-36.5 document detail contract', () => {
  it('keeps ordinary source anchors human-readable without vector internals', () => {
    const anchors = ['page:12', 'slide:8', 'sheet:成绩 A1:F28']
    expect(anchors.map(value => value.replace(/^page:/u, '第 ').replace(/^slide:/u, '第 ').replace(/^sheet:/u, '工作表：'))).toEqual(['第 12', '第 8', '工作表：成绩 A1:F28'])
  })

  it('requires a source anchor for every user-facing answer citation', () => {
    const citations = [{ title: '资料', section: '第二章', source_anchor: 'page:12', text: '内容', score: 0.8 }]
    expect(citations.every(item => item.source_anchor.length > 0 && item.text.length > 0)).toBe(true)
  })
})
