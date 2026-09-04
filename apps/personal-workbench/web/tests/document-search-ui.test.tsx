// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentStudyPanel } from '../src/components/DocumentStudyPanel.tsx'

const document = {
  id: 'document-1', task_id: 'task-1', project_id: 'project-1', source_type: 'local_file', source_url: 'lesson.pdf', canonical_url: 'local-document:lesson', title: '力学资料', author: null, site_name: '本机文档', description: null, language: 'zh', content_type: 'application/pdf', content: '牛顿第二定律。',
  sections: [{ heading: '第二章 动力学', level: 1, text: '牛顿第二定律说明力与加速度。', source_anchor: 'page:12' }], code_blocks: [], links: [], metadata: {}, acquired_at: '2026-09-01T00:00:00.000Z', content_sha256: 'a'.repeat(64),
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => ({ ok: true, data: url.includes('/ask') ? { answer: '资料说明力与加速度有关。', citations: [{ title: '力学资料', section: '第二章 动力学', source_anchor: 'page:12', text: '牛顿第二定律说明力与加速度。', score: 0.9 }] } : document }) })))
})
afterEach(() => vi.unstubAllGlobals())

describe('DocumentStudyPanel', () => {
  it('shows a source-anchored question and answer without embedding internals', async () => {
    render(<DocumentStudyPanel taskId="task-1" advancedMode={false} />)
    await screen.findByText('资料结构')
    expect(screen.getByText('第二章 动力学')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('输入关于这份资料的问题'), { target: { value: '牛顿第二定律在哪一页？' } })
    fireEvent.click(screen.getByText('提问'))
    await waitFor(() => expect(screen.getByText('资料说明力与加速度有关。')).toBeInTheDocument())
    expect(screen.getAllByText(/第 12/u).length).toBeGreaterThan(0)
    expect(screen.queryByText(/embedding ID/u)).not.toBeInTheDocument()
  })
})
