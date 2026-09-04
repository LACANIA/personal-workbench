import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoCreateInput, VideoJobRecord } from '../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { UniversalInputService, type PickerResult } from '../src/input/service.ts'
import { KnowledgeIngestionService } from '../src/ingestion/service.ts'
import { SourceDetector } from '../src/ingestion/source-detector.ts'
import { ProjectContextService } from '../src/projects/service.ts'
import { TaskManager } from '../src/tasks/manager.ts'
import type { VideoKnowledgeService } from '../src/video/service.ts'
import { PATHS } from '../src/config.ts'

const roots: string[] = []
const externalRoots: string[] = []
const databases: WorkbenchDatabase[] = []

async function fixture(): Promise<{
  root: string
  database: WorkbenchDatabase
  inputs: UniversalInputService
  projects: ProjectContextService
  tasks: TaskManager
}> {
  const testRoot = path.join(PATHS.appRoot, 'data', 'test-runtime')
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(path.join(testRoot, 'step31-ingestion-'))
  roots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  databases.push(database)
  const inputs = new UniversalInputService(database)
  const projects = new ProjectContextService(database, inputs)
  await projects.ensurePersonalInbox(path.join(root, 'personal-inbox'))
  return { root, database, inputs, projects, tasks: new TaskManager(database, undefined, inputs) }
}

async function externalRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-workbench-ingestion-external-'))
  externalRoots.push(root)
  return root
}

function picker(kind: 'file' | 'directory', selectedPath: string | null): (requested: 'file' | 'directory') => Promise<PickerResult> {
  return async requested => ({ canceled: selectedPath === null, path: selectedPath, kind: requested === 'directory' ? 'directory' : kind })
}

function videoStub(database: WorkbenchDatabase, tasks: TaskManager): { service: VideoKnowledgeService; start: ReturnType<typeof vi.fn> } {
  const jobs = new Map<string, VideoJobRecord>()
  const start = vi.fn()
  const create = (input: VideoCreateInput): VideoJobRecord => {
    const project = database.getProjectContext(input.project_id!)!
    const task = tasks.create({
      templateId: 'video-to-knowledge', title: input.title, inputType: input.input_type, inputValue: input.input_value,
      workspacePath: project.rootPath, projectName: project.name,
      ...(input.input_asset_id === undefined ? {} : { inputAssetId: input.input_asset_id }),
    })
    const timestamp = new Date().toISOString()
    const job: VideoJobRecord = {
      id: randomUUID(), project_id: project.id, task_id: task.id, input_type: input.input_type, input_value: input.input_value,
      title: input.title ?? '视频来源', language: 'auto', status: 'created', stage: 'created', progress: 0,
      source_path: null, subtitle_path: null, video_document_id: null, error_code: null, error_message: null,
      created_at: timestamp, updated_at: timestamp, completed_at: null, metadata: {},
    }
    jobs.set(job.id, job)
    return job
  }
  return {
    service: {
      create,
      start,
      repository: { getJob: (id: string) => jobs.get(id) },
    } as unknown as VideoKnowledgeService,
    start,
  }
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  const internalBoundary = path.resolve(PATHS.appRoot, 'data', 'test-runtime')
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(`${internalBoundary}${path.sep}`)) throw new Error('unsafe internal test cleanup path')
    await rm(root, { recursive: true, force: true })
  }
  const tempBoundary = path.resolve(os.tmpdir())
  for (const root of externalRoots.splice(0)) {
    if (!path.resolve(root).startsWith(`${tempBoundary}${path.sep}personal-workbench-ingestion-external-`)) throw new Error('unsafe external test cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

describe('STEP-31 universal knowledge ingestion', () => {
  it('extracts URLs from title text and classifies GitHub, video, web and text sources without reading them', async () => {
    const { inputs } = await fixture()
    const detector = new SourceDetector(inputs)
    const text = detector.detect({ input_value: '整理这段本地笔记，并保留任务来源。' })
    expect(text).toMatchObject({ source_type: 'text_input', display_name: '文本输入' })
    expect(text.metadata).not.toHaveProperty('text')
    expect(detector.detect({ input_value: '【IQ 信号学习】 https://www.bilibili.com/video/BV1YpQUBpEbL/?share_source=copy_web' })).toMatchObject({
      source_type: 'video_url', source_reference: 'https://www.bilibili.com/video/BV1YpQUBpEbL/?share_source=copy_web', display_name: 'IQ 信号学习',
      metadata: { input_title: 'IQ 信号学习' },
    })
    expect(detector.detect({ input_value: 'https://b23.tv/example' }).source_type).toBe('video_url')
    expect(detector.detect({ input_value: '复习 https://www.youtube.com/watch?v=example' }).source_type).toBe('video_url')
    expect(detector.detect({ input_value: 'https://www.douyin.com/video/123456' }).source_type).toBe('video_url')
    expect(detector.detect({ input_value: '帮我重点整理安装方式和目录 https://github.com/example/repository.git' })).toMatchObject({
      source_type: 'github_repo', source_reference: 'https://github.com/example/repository', display_name: '帮我重点整理安装方式和目录',
      metadata: { github_kind: 'repository', user_instruction: '帮我重点整理安装方式和目录' },
    })
    expect(detector.detect({ input_value: 'https://github.com/example/repository/issues/8' })).toMatchObject({
      source_type: 'github_repo', source_reference: 'https://github.com/example/repository/issues/8', metadata: { github_kind: 'issue' },
    })
    expect(detector.detect({ input_value: '帮我整理这个网页的重点 https://example.com/guide' })).toMatchObject({
      source_type: 'web_url', source_reference: 'https://example.com/guide', metadata: { user_instruction: '帮我整理这个网页的重点' },
    })
    expect(detector.detect({ input_value: 'https://example.com/guide' }).source_type).toBe('web_url')
    expect(detector.detect({ input_value: 'E:\\outside\\notes.md' })).toMatchObject({ source_type: 'local_file', metadata: { source_mode: 'manual_path', authorization_required: true } })
    expect(detector.detect({ input_value: 'E:\\outside\\folder' })).toMatchObject({ source_type: 'local_folder', metadata: { authorization_required: true } })
  })

  it('uses a native selected file as a local file source and preserves the grant metadata', async () => {
    const { database } = await fixture()
    const sourceFile = path.join(await externalRoot(), 'outside-note.md')
    await writeFile(sourceFile, '# note\n本机知识输入', 'utf8')
    const selectedInputs = new UniversalInputService(database, picker('file', sourceFile))
    const selected = await selectedInputs.select('file', true)
    const detector = new SourceDetector(selectedInputs)
    const source = detector.detect({ input_asset_id: selected.asset!.asset.id })
    expect(source).toMatchObject({
      source_type: 'local_file', source_reference: selected.asset!.effective_path,
      metadata: { input_asset_id: selected.asset!.asset.id, access_mode: 'temporary_grant', source_mode: 'native_picker' },
    })
    const managedTasks = new TaskManager(database, undefined, selectedInputs)
    const start = vi.spyOn(managedTasks, 'start').mockImplementation(async id => {
      managedTasks.startExternal(id, { stage: 'processing', progress: 60, message: '测试文件分析分流。', activeModel: null })
      return managedTasks.completeExternal(id, { resultText: '测试文件分析完成。', metadata: { execution: 'test' } })
    })
    const { service: video } = videoStub(database, managedTasks)
    const ingestion = new KnowledgeIngestionService(database, managedTasks, video)
    const result = await ingestion.ingest({ input_asset_id: selected.asset!.asset.id })
    expect(result.ingestion).toMatchObject({ source_type: 'local_file', pipeline: 'file_analysis' })
    expect(result.task.projectId).toBe(database.getPersonalInboxProject()!.id)
    expect(start).toHaveBeenCalledWith(result.task.id)
    expect(database.getTask(result.task.id)?.status).toBe('completed')
  })

  it('routes a native selected folder to inventory without registering a new project', async () => {
    const { database } = await fixture()
    const selectedRoot = path.join(await externalRoot(), 'outside-folder')
    await mkdir(selectedRoot)
    await writeFile(path.join(selectedRoot, 'README.md'), '# folder', 'utf8')
    const selectedInputs = new UniversalInputService(database, picker('directory', selectedRoot))
    const selected = await selectedInputs.select('directory', true)
    const tasks = new TaskManager(database, undefined, selectedInputs)
    const start = vi.spyOn(tasks, 'start').mockImplementation(async id => {
      tasks.startExternal(id, { stage: 'processing', progress: 60, message: '测试文件夹统计分流。', activeModel: null })
      return tasks.completeExternal(id, { resultText: '测试文件夹统计完成。', metadata: { execution: 'test' } })
    })
    const { service: video } = videoStub(database, tasks)
    const ingestion = new KnowledgeIngestionService(database, tasks, video)
    const projectCount = database.listProjectContexts().length
    const result = await ingestion.ingest({ input_asset_id: selected.asset!.asset.id })
    expect(result.ingestion).toMatchObject({ source_type: 'local_folder', pipeline: 'folder_inventory' })
    expect(result.task.projectId).toBe(database.getPersonalInboxProject()!.id)
    expect(database.listProjectContexts()).toHaveLength(projectCount)
    expect(start).toHaveBeenCalledWith(result.task.id)
    expect(database.getTask(result.task.id)?.status).toBe('completed')
  })

  it('records detector and adapter runtime stages before the Video Knowledge service starts', async () => {
    const { database, tasks } = await fixture()
    const { service: video, start } = videoStub(database, tasks)
    const ingestion = new KnowledgeIngestionService(database, tasks, video)
    const result = await ingestion.ingest({ input_value: 'https://www.bilibili.com/video/BV1YpQUBpEbL/?share_source=copy_web' })
    expect(result.ingestion).toMatchObject({ source_type: 'video_url', pipeline: 'video_knowledge' })
    expect(start).toHaveBeenCalledWith(result.video_job!.id)
    const events = database.listEvents(result.task.id)
    expect(events.some(event => event.eventType === 'ingestion.source.detected')).toBe(true)
    expect(events.some(event => event.eventType === 'runtime.stage' && (event.payload as { current_stage?: string }).current_stage === 'detecting_source')).toBe(true)
    expect(events.some(event => event.eventType === 'runtime.stage' && (event.payload as { current_stage?: string }).current_stage === 'adapting')).toBe(true)
  })

  it('routes public web and GitHub sources to their adapters while text remains local registration', async () => {
    const { database, tasks } = await fixture()
    const { service: video, start } = videoStub(database, tasks)
    const ingestion = new KnowledgeIngestionService(database, tasks, video)
    expect(ingestion.detect({ input_value: 'https://example.com/private-guide' }).source_type).toBe('web_url')
    expect(ingestion.detect({ input_value: 'https://github.com/example/repository' })).toMatchObject({ source_type: 'github_repo', metadata: { github_kind: 'repository' } })
    const text = await ingestion.ingest({ input_value: '这是给朋友整理的一段复习文本。' })
    expect(text.video_job).toBeNull()
    expect(database.getTask(text.task.id)?.status).toBe('completed')
    expect(database.getTaskRuntime(text.task.id)).toMatchObject({ current_stage: 'completed', status: 'completed' })
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps the ingestion database additive and internally consistent', async () => {
    const { database, tasks } = await fixture()
    const { service: video } = videoStub(database, tasks)
    const ingestion = new KnowledgeIngestionService(database, tasks, video)
    const result = await ingestion.ingest({ input_value: '输入来源完整性检查' })
    expect(ingestion.get(result.ingestion.id)).toMatchObject({ task_id: result.task.id })
    expect(ingestion.list(database.getPersonalInboxProject()!.id)).toHaveLength(1)
    expect(database.runtimeIntegrity()).toEqual({ integrity_check: 'ok', foreign_key_check: [] })
  })
})
