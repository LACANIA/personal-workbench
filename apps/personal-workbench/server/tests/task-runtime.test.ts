import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/database.ts'
import { TaskManager } from '../src/tasks/manager.ts'

const roots: string[] = []

async function fixtureDatabase(): Promise<WorkbenchDatabase> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-workbench-runtime-'))
  roots.push(root)
  return new WorkbenchDatabase(path.join(root, 'workbench.db'))
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Task Runtime state and event history', () => {
  it('creates a persistent created runtime alongside a task', async () => {
    const database = await fixtureDatabase()
    try {
      database.createTask('runtime-created', { templateId: 'memory-query', inputValue: '状态' })
      expect(database.getTaskRuntime('runtime-created')).toMatchObject({ task_id: 'runtime-created', task_type: 'memory-query', current_stage: 'created', progress: 0, status: 'created' })
    } finally { database.close() }
  })

  it('records stage, progress and log entries for an external task', async () => {
    const database = await fixtureDatabase(); const tasks = new TaskManager(database)
    try {
      database.createTask('runtime-video', { templateId: 'video-to-knowledge', inputValue: 'E:\\fixture.srt', inputType: 'subtitle' })
      tasks.startExternal('runtime-video', { stage: 'initializing', progress: 5, message: '正在检查媒体输入。' })
      tasks.updateRuntime('runtime-video', { current_stage: 'transcribing', progress: 42, status: 'running', message: '正在进行本地转写。', active_model: 'faster-whisper-small' })
      tasks.runtimeLog('runtime-video', { stage: 'transcribing', level: 'info', message: '已取得音轨。' })
      tasks.recordEvent('runtime-video', 'tool/call', 'harness', { toolName: 'personal_read' })
      const view = tasks.runtimeView('runtime-video')
      expect(view.runtime).toMatchObject({ current_stage: 'transcribing', progress: 42, status: 'running', active_model: 'faster-whisper-small' })
      expect(view.completed_stages).toContain('initializing')
      expect(view.logs).toContainEqual(expect.objectContaining({ stage: 'transcribing', message: '已取得音轨。' }))
      expect(view.active_tool).toBe('personal_read')
      expect(database.listEvents('runtime-video').some(event => event.eventType === 'runtime.state')).toBe(true)
    } finally { database.close() }
  })

  it('marks a completed external task without removing runtime history', async () => {
    const database = await fixtureDatabase(); const tasks = new TaskManager(database)
    try {
      database.createTask('runtime-complete', { templateId: 'video-to-knowledge', inputValue: 'E:\\fixture.srt', inputType: 'subtitle' })
      tasks.startExternal('runtime-complete', { stage: 'embedding', progress: 70, message: '正在建立检索索引。', activeModel: 'qwen3-embedding:0.6b' })
      tasks.completeExternal('runtime-complete', { resultText: '完成', metadata: { execution: 'test' } })
      expect(tasks.runtime('runtime-complete')).toMatchObject({ current_stage: 'completed', progress: 100, status: 'completed', active_model: null })
      expect(database.getTask('runtime-complete')?.status).toBe('completed')
      expect(tasks.runtimeView('runtime-complete').completed_stages).toContain('completed')
    } finally { database.close() }
  })

  it('reports current runtime information without changing the database', async () => {
    const database = await fixtureDatabase(); const tasks = new TaskManager(database)
    try {
      database.createTask('runtime-monitor', { templateId: 'asset-inventory', inputValue: 'E:\\fixture', inputType: 'directory' })
      tasks.startExternal('runtime-monitor', { stage: 'processing', progress: 35, message: '正在统计目录。', activeModel: null })
      const monitor = await tasks.monitor()
      expect(monitor.current_task).toMatchObject({ task_id: 'runtime-monitor', task_type: 'asset-inventory', progress: 35 })
      expect(monitor.cpu.logical_cores).toBeGreaterThan(0)
      expect(monitor.memory.total_mb).toBeGreaterThan(0)
      expect(database.runtimeIntegrity()).toMatchObject({ integrity_check: 'ok', foreign_key_check: [] })
    } finally { database.close() }
  })
})
