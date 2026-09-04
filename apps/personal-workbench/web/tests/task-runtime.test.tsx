// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskRuntimePanel } from '../src/components/TaskRuntimePanel.tsx'

const runtime = {
  runtime: {
    task_id: 'runtime-ui', task_type: 'video-to-knowledge', current_stage: 'transcribing', progress: 42, status: 'running',
    message: '正在进行本地转写。', started_at: '2026-08-25T00:00:00.000Z', finished_at: null, active_model: 'faster-whisper-small', updated_at: '2026-08-25T00:00:05.000Z',
  },
  completed_stages: ['created', 'initializing', 'fetching'],
  logs: [{ timestamp: '2026-08-25T00:00:04.000Z', stage: 'transcribing', level: 'info', message: '已取得音轨。' }],
  active_tool: 'faster-whisper-small',
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/runtime')) return { ok: true, json: async () => ({ ok: true, data: runtime }) }
    return { ok: true, body: null, json: async () => ({ ok: true, data: [] }) }
  }))
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Task Runtime panel', () => {
  it('shows stage, progress, active model, duration and live logs', async () => {
    render(<TaskRuntimePanel taskId="runtime-ui" />)
    await waitFor(() => expect(screen.getByText('当前步骤：ASR 转写')).toBeInTheDocument())
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getAllByText('faster-whisper-small')).toHaveLength(2)
    expect(screen.getByText('实时日志')).toBeInTheDocument()
    expect(screen.getByText('已取得音轨。')).toBeInTheDocument()
    expect(screen.getByText('完成步骤')).toBeInTheDocument()
    expect(screen.getByText('当前工具')).toBeInTheDocument()
  })
})
