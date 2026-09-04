// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskTemplate } from '../../shared/contracts/index.ts'
import { recognizeInput } from '../src/features/input-recognition.ts'
import { TaskDetail } from '../src/components/TaskDetail.tsx'
import { MemoryPage } from '../src/pages/MemoryPage.tsx'
import { ProjectsPage } from '../src/pages/ProjectsPage.tsx'
import { ReviewQueuePage } from '../src/pages/ReviewQueuePage.tsx'
import { TasksPage } from '../src/pages/TasksPage.tsx'
import { VideoPage } from '../src/pages/VideoPage.tsx'
import { WorkbenchPage } from '../src/pages/WorkbenchPage.tsx'

const snapshot = {
  health: { status: 'ok', checks: [] }, capabilities: null, models: { models: [] }, profiles: [],
  workspaces: { allowedRoots: ['C:\\workspace'], recent: [] }, projects: [],
  projectContexts: [{
    id: 'project-1', name: 'Personal Agent', rootPath: 'C:\\workspace\\personal-workbench', description: '本机扩展工程', projectType: 'node' as const,
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', lastScanAt: '2026-08-20T00:00:00.000Z',
    assetStats: { id: 'scan-1', projectId: 'project-1', canonicalRoot: 'C:\\workspace\\personal-workbench', fileCount: 20, directoryCount: 8, totalBytes: 1024,
      extensionDistribution: [{ extension: '.ts', count: 10 }], recentFiles: [], largeFiles: [], skippedCount: 1, durationMs: 10,
      detectedSignals: { hasSrc: true, hasDocs: true, hasReadme: true, hasPackageJson: true, hasPyprojectToml: false, hasPdf: false }, createdAt: '2026-08-20T00:00:00.000Z' },
    recentTasks: [], taskCount: 2, memoryReferenceCount: 0, memoryReferences: [],
    changeSummary: { latest_snapshot_id: 'scan-2', previous_snapshot_id: 'scan-1', latest_scan_time: '2026-08-20T01:00:00.000Z', previous_scan_time: '2026-08-20T00:00:00.000Z', added_files_estimate: 3, file_count_change: 3, size_change: 512, file_change_ratio: 0.176471, new_extensions: ['.md'], removed_extensions: [] },
    actions: [
      { action_type: 'create_task' as const, label: '创建资产清单任务', payload: {} },
      { action_type: 'rescan_project' as const, label: '重新扫描项目', payload: {} },
      { action_type: 'generate_report' as const, label: '创建项目报告任务', payload: {} },
    ],
    recommendedActions: ['资产清单', '项目总结'],
  }],
  memory: { userVersion: 4, counts: { projects: 1, documents: 2, document_chunks: 3 }, ftsCount: 3 },
  documentSearch: { ftsCount: 3 },
  legacy: { present: true, manifestAvailable: true, totalCandidates: 20, counts: { A: 0, B: 9, C: 9, E: 2 } },
  localConfig: null,
  distribution: null,
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: [] }) }))
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('input recognition', () => {
  it('recommends video tasks for URLs', () => expect(recognizeInput('https://example.test/video').recommended).toEqual(['video-to-knowledge']))
  it('recognizes a URL that is accompanied by a user title or instruction', () => expect(recognizeInput('帮我整理这个项目 https://github.com/octocat/Hello-World')).toMatchObject({ type: 'url', label: '网址' }))
  it('recommends file analysis for Markdown', () => expect(recognizeInput('C:\\workspace\\x.md').recommended[0]).toBe('file-analysis'))
  it('recommends asset inventory for a directory-shaped path', () => expect(recognizeInput('C:\\workspace\\personal-workbench\\').recommended[0]).toBe('asset-inventory'))
  it('recommends Memory query for natural language', () => expect(recognizeInput('总结项目')).toMatchObject({ type: 'natural_language', label: '自然语言问题' }))
})

describe('Workbench pages', () => {
  it('renders the Memory evidence page and Schema v4', () => { render(<MemoryPage snapshot={snapshot} databaseRole="test" />); expect(screen.getByText('从结构化记录定位到原始文档分块')).toBeInTheDocument(); expect(screen.getByText('v4')).toBeInTheDocument() })
  it('renders the empty task history', () => { render(<TasksPage tasks={[]} onOpenTask={() => undefined} />); expect(screen.getByText('尚无任务记录')).toBeInTheDocument() })
  it('renders the unified knowledge ingestion form while retaining the Video Knowledge pipeline', () => { render(<VideoPage snapshot={snapshot} developerMode={false} advancedMode />); expect(screen.getByText('创建知识导入任务')).toBeInTheDocument(); expect(screen.getByText('视频网址')).toBeInTheDocument(); expect(screen.getByText(/本机 ASR 按顺序选择/u)).toBeInTheDocument() })
  it('renders the full local video state pipeline', () => { render(<VideoPage snapshot={snapshot} developerMode={false} advancedMode />); expect(screen.getByText('创建')).toBeInTheDocument(); expect(screen.getByText('发布')).toBeInTheDocument(); expect(screen.getByText('审核')).toBeInTheDocument() })
  it('renders the Project Context list and asset summary', () => {
    render(<ProjectsPage snapshot={snapshot} databaseRole="production" onOpenTask={() => undefined} onRefresh={async () => undefined} />)
    expect(screen.getAllByText('Personal Agent').length).toBeGreaterThan(0)
    expect(screen.getAllByText('20').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Node.js 项目').length).toBeGreaterThan(0)
    expect(screen.getByText('从项目资产变化中提取状态线索')).toBeInTheDocument()
    expect(screen.getAllByText('最近变化').length).toBeGreaterThan(0)
    expect(screen.getByText('项目时间线')).toBeInTheDocument()
    expect(screen.getByText('创建资产清单任务')).toBeInTheDocument()
    expect(screen.getByText('Artifact Intelligence')).toBeInTheDocument()
  })

  it('renders the project Evidence Intelligence dashboard and Issue Center', async () => {
    const health = {
      project_id: 'project-1', project_name: 'Personal Agent', artifact_count: 3, covered_count: 2, coverage: 2 / 3,
      health_summary: { healthy: 1, warning: 1, broken: 1 }, issue_count: 2,
      issues: [
        { artifact_id: 'warning-1', artifact_name: 'warning.md', severity: 'missing', code: 'EVIDENCE_MISSING', issue: 'Artifact 当前没有 Evidence 关系。', created_at: '2026-08-21T01:00:00.000Z' },
        { artifact_id: 'broken-1', artifact_name: 'broken.md', severity: 'broken', code: 'EVIDENCE_SOURCE_UNAVAILABLE', issue: 'Evidence 来源当前不存在或无法读取。', created_at: '2026-08-21T01:00:00.000Z' },
      ],
      recent_audits: [{ id: 'audit-1', artifact_id: 'healthy-1', artifact_name: 'healthy.md', artifact_type: 'report', status: 'healthy', issues: [], created_at: '2026-08-21T00:59:00.000Z' }],
      release_summary: { ready: 1, needs_review: 1, rejected: 1 }, release_readiness: [], checked_at: '2026-08-21T01:00:00.000Z',
    }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const data = url.includes('/evidence-health') ? health : url.includes('/review-summary') ? {
        project_id: 'project-1', project_name: 'Personal Agent', artifact_count: 3, pending: 1, approved: 1, needs_revision: 0, rejected: 1, queue_count: 2, generated_at: '2026-08-21T01:00:00.000Z',
      } : []
      return { ok: true, json: async () => ({ ok: true, data }) }
    }))
    render(<ProjectsPage snapshot={snapshot} databaseRole="production" onOpenTask={() => undefined} onRefresh={async () => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Evidence Intelligence' }))
    await waitFor(() => expect(screen.getByText('66.7%')).toBeInTheDocument())
    expect(screen.getByText('Evidence Issue Center')).toBeInTheDocument()
    expect(screen.getByText('broken.md')).toBeInTheDocument()
    expect(screen.getByText('Release Readiness')).toBeInTheDocument()
    expect(screen.getByText('Review Overview')).toBeInTheDocument()
    expect(screen.getByText('REJECTED')).toBeInTheDocument()
    expect(screen.getByText('healthy.md')).toBeInTheDocument()
  })

  it('renders the homepage Project Health card', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: {
      project_id: 'project-1', project_name: 'Personal Agent', artifact_count: 4, covered_count: 3, coverage: 0.75,
      health_summary: { healthy: 2, warning: 1, broken: 1 }, issue_count: 2, issues: [], recent_audits: [],
      release_summary: { ready: 2, needs_review: 1, rejected: 1 }, release_readiness: [], checked_at: '2026-08-21T01:00:00.000Z',
    } }) }))
    render(<WorkbenchPage snapshot={snapshot} templates={[]} tasks={[]} databaseRole="production" advancedMode onTaskCreated={() => undefined} onOpenTask={() => undefined} />)
    await waitFor(() => expect(screen.getByText('75.0%')).toBeInTheDocument())
    expect(screen.getByText('Project Health')).toBeInTheDocument()
    expect(screen.getByText('Evidence Coverage')).toBeInTheDocument()
    expect(screen.getByText('Issues')).toBeInTheDocument()
  })

  it('renders registered task artifacts in the Artifact tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: {
      task: {
        id: 'task-artifact', projectId: 'project-1', templateId: 'project-summary', title: '项目报告', inputType: 'question', inputValue: '总结项目', workspacePath: 'C:\\workspace\\personal-workbench', projectName: 'Personal Agent', profile: 'personal-research', permissionMode: 'read-only', status: 'completed', createdAt: '2026-08-21T00:00:00.000Z', startedAt: '2026-08-21T00:00:01.000Z', completedAt: '2026-08-21T00:00:02.000Z', harnessSessionId: 'session-1', runtimePid: null, resultText: '完成', errorCode: null, errorMessage: null, artifactIndex: [], citationIndex: [], metadata: {},
      },
      events: [],
      artifacts: [{ id: 'artifact-1', project_id: 'project-1', task_id: 'task-artifact', artifact_type: 'report', name: 'report.md', relative_path: 'output\\report.md', absolute_path: 'C:\\workspace\\personal-workbench\\output\\report.md', mime_type: 'text/markdown', size_bytes: 128, sha256: 'a'.repeat(64), status: 'active', version_count: 1, created_at: '2026-08-21T00:00:03.000Z', metadata: {} }],
      artifactCandidates: [],
    } }) }))
    render(<TaskDetail taskId="task-artifact" />)
    await waitFor(() => expect(screen.getByText('项目报告')).toBeInTheDocument())
    fireEvent.click(screen.getByText('产物'))
    expect(screen.getByText('输入')).toBeInTheDocument()
    expect(screen.getByText('输出')).toBeInTheDocument()
    expect(screen.getByText('生成文件')).toBeInTheDocument()
    expect(screen.getByText('引用文件')).toBeInTheDocument()
    expect(screen.getByText('report.md')).toBeInTheDocument()
    expect(screen.getByText('保存回答为报告')).toBeInTheDocument()
    expect(screen.getByText('打开文件位置')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /当前 Task/u })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /当前 Session/u })).toBeChecked()
  })

  it('renders Artifact Evidence relations on the Project page', async () => {
    const artifact = { id: 'artifact-evidence', project_id: 'project-1', task_id: 'task-artifact', artifact_type: 'report', name: 'evidence-report.md', relative_path: 'output\\evidence-report.md', absolute_path: 'C:\\workspace\\personal-workbench\\output\\evidence-report.md', mime_type: 'text/markdown', size_bytes: 256, sha256: 'b'.repeat(64), status: 'active', version_count: 1, created_at: '2026-08-21T00:00:03.000Z', metadata: {} }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const data = url.includes('/api/projects/project-1/artifacts')
        ? [artifact]
        : url.includes('/api/artifacts/artifact-evidence/evidence')
          ? { artifact, count: 2, evidence: [
            { id: 'evidence-task', artifact_id: artifact.id, source_type: 'task', source_id: 'task-artifact', relation_type: 'generated_from', created_at: '2026-08-21T00:00:04.000Z', metadata: {}, source: { type: 'task', id: 'task-artifact', label: 'Project report task', available: true, metadata: {} } },
            { id: 'evidence-memory', artifact_id: artifact.id, source_type: 'memory', source_id: 'decision:1', relation_type: 'references', created_at: '2026-08-21T00:00:05.000Z', metadata: { database_role: 'test' }, source: { type: 'memory', id: 'decision:1', label: 'decision #1 · GNN decision', available: true, metadata: {} } },
          ] }
          : []
      return { ok: true, json: async () => ({ ok: true, data }) }
    }))
    render(<ProjectsPage snapshot={snapshot} databaseRole="test" onOpenTask={() => undefined} onRefresh={async () => undefined} />)
    await waitFor(() => expect(screen.getAllByText('evidence-report.md').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }))
    await waitFor(() => expect(screen.getByText('Project report task')).toBeInTheDocument())
    expect(screen.getByText('decision #1 · GNN decision')).toBeInTheDocument()
    expect(screen.getByText('2 条关系')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '添加 Evidence 关系' })).toBeInTheDocument()
  })

  it('renders the lightweight Artifact Provenance graph and detail tabs', async () => {
    const artifact = { id: 'artifact-provenance', project_id: 'project-1', task_id: 'task-provenance', artifact_type: 'report', name: 'provenance-report.md', relative_path: 'output\\provenance-report.md', absolute_path: 'C:\\workspace\\personal-workbench\\output\\provenance-report.md', mime_type: 'text/markdown', size_bytes: 512, sha256: 'c'.repeat(64), status: 'active', version_count: 1, created_at: '2026-08-21T00:00:03.000Z', metadata: {} }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const data = url.includes('/api/projects/project-1/artifacts')
        ? [artifact]
        : url.includes('/api/artifacts/artifact-provenance/provenance')
          ? {
            artifact_id: artifact.id,
            project_id: 'project-1',
            generated_at: '2026-08-21T00:00:06.000Z',
            nodes: [
              { id: `artifact:${artifact.id}`, entity_id: artifact.id, type: 'artifact', title: artifact.name, status: 'active' },
              { id: 'task:task-provenance', entity_id: 'task-provenance', type: 'task', title: 'Provenance Task', status: 'completed' },
            ],
            edges: [{ source: `artifact:${artifact.id}`, target: 'task:task-provenance', relation_type: 'generated_from', evidence_id: 'evidence-1' }],
          }
          : []
      return { ok: true, json: async () => ({ ok: true, data }) }
    }))
    render(<ProjectsPage snapshot={snapshot} databaseRole="test" onOpenTask={() => undefined} onRefresh={async () => undefined} />)
    await waitFor(() => expect(screen.getAllByText('provenance-report.md').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Provenance' }))
    await waitFor(() => expect(screen.getByRole('img', { name: 'Artifact Provenance Graph' })).toBeInTheDocument())
    expect(screen.getAllByText('generated_from').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '导出 artifact-provenance.json' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Artifact 详情标签' })).toBeInTheDocument()
  })

  it('renders the Human Approval Review Queue and submits explicit decisions', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const data = url.includes('/review-summary')
        ? { project_id: 'project-1', project_name: 'Personal Agent', artifact_count: 2, pending: 1, approved: 0, needs_revision: 0, rejected: 1, queue_count: 2, generated_at: '2026-08-21T02:00:00.000Z' }
        : url.includes('/reviews')
          ? { project_id: 'project-1', project_name: 'Personal Agent', count: 2, generated_at: '2026-08-21T02:00:00.000Z', reviews: [
            { artifact_id: 'warning-1', artifact_name: 'warning-report.md', artifact_type: 'report', artifact_status: 'outdated', issue: 'Artifact 文件内容已经变化。', issues: [], severity: 'warning', evidence_status: 'available', audit_status: 'warning', release_status: 'NEEDS_REVIEW', current_decision: 'pending', updated_at: '2026-08-21T01:00:00.000Z' },
            { artifact_id: 'broken-1', artifact_name: 'broken-report.md', artifact_type: 'report', artifact_status: 'active', issue: 'Evidence 来源当前不存在。', issues: [], severity: 'broken', evidence_status: 'broken', audit_status: 'broken', release_status: 'REJECTED', current_decision: 'rejected', updated_at: '2026-08-21T01:30:00.000Z' },
          ] }
          : { id: 'review-1', artifact_id: 'warning-1', decision: 'approved', reviewer: 'local-user', note: '', created_at: '2026-08-21T02:01:00.000Z' }
      return { ok: true, json: async () => ({ ok: true, data }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ReviewQueuePage snapshot={snapshot} />)
    await waitFor(() => expect(screen.getByText('warning-report.md')).toBeInTheDocument())
    expect(screen.getByText('broken-report.md')).toBeInTheDocument()
    expect(screen.getByText('Human Approval Gate')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '批准' })[0]!)
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true))
  })

  it('renders Artifact Review history without modifying the Artifact form', async () => {
    const artifact = { id: 'artifact-review', project_id: 'project-1', task_id: null, artifact_type: 'report', name: 'review-report.md', relative_path: 'output\\review-report.md', absolute_path: 'C:\\workspace\\personal-workbench\\output\\review-report.md', mime_type: 'text/markdown', size_bytes: 128, sha256: 'd'.repeat(64), status: 'active', version_count: 1, created_at: '2026-08-21T00:00:03.000Z', metadata: {} }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const data = url.includes('/api/projects/project-1/artifacts') ? [artifact]
        : url.includes('/api/artifacts/artifact-review/reviews/history') ? {
          artifact, current_decision: 'needs_revision', count: 1,
          history: [{ id: 'review-history-1', artifact_id: artifact.id, decision: 'needs_revision', reviewer: 'reviewer-a', note: '补充来源定位', created_at: '2026-08-21T01:00:00.000Z' }],
        }
          : url.includes('/review-summary') ? { project_id: 'project-1', project_name: 'Personal Agent', artifact_count: 1, pending: 0, approved: 0, needs_revision: 1, rejected: 0, queue_count: 1, generated_at: '2026-08-21T01:00:00.000Z' }
            : []
      return { ok: true, json: async () => ({ ok: true, data }) }
    }))
    render(<ProjectsPage snapshot={snapshot} databaseRole="production" onOpenTask={() => undefined} onRefresh={async () => undefined} />)
    await waitFor(() => expect(screen.getAllByText('review-report.md').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByText('补充来源定位')).toBeInTheDocument())
    expect(screen.getByText('reviewer-a')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '需要修订' })).toBeInTheDocument()
  })
})
