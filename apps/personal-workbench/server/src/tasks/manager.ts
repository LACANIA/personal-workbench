import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { ArtifactEvidenceCreateInput, DatabaseRole, RuntimeMonitor, TaskCreateInput, TaskEvent, TaskReportCandidateResult, TaskRuntimeLogEntry, TaskRuntimeStage, TaskRuntimeState, TaskRuntimeStatus, TaskRuntimeView, TaskWordExportResult, TemplateId, WorkbenchTask } from '../../../shared/contracts/index.ts'
import { ArtifactService, artifactBelongsToRoot, artifactMimeType } from '../artifacts/service.ts'
import { collectAssetInventory } from '../assets/inventory.ts'
import { PATHS, PROFILE_ALLOWLIST, templateById } from '../config.ts'
import { WorkbenchDatabase } from '../database.ts'
import { extractCitations, harnessEventType, runHarnessTask, sanitizeHarnessNotification, shouldPersistHarnessNotification } from '../harness/adapter.ts'
import { UniversalInputService } from '../input/service.ts'
import { runProcess } from '../process.ts'
import { createDocxFromMarkdown, validateDocx } from '../reports/docx.ts'
import { assertAllowedExisting } from '../security/path-policy.ts'

type CancelHandle = () => Promise<void>

function now(): string { return new Date().toISOString() }

function toolNameFromPayload(payload: Record<string, unknown>): string | null {
  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 3 || value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    for (const key of ['tool_name', 'toolName', 'name']) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim().length > 0 && candidate.length <= 160) return candidate.trim()
    }
    for (const key of ['tool', 'call', 'tool_call', 'toolCall', 'event', 'params']) {
      const candidate = visit(record[key], depth + 1)
      if (candidate !== null) return candidate
    }
    return null
  }
  return visit(payload, 0)
}

function nvidiaSmiPath(): string | null {
  const file = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi'
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory.replace(/^"|"$/gu, ''), file)
    if (existsSync(candidate)) return candidate
  }
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) {
    const candidate = path.join(process.env.SystemRoot, 'System32', file)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const RUNTIME_STAGES: readonly TaskRuntimeStage[] = [
  'created', 'initializing', 'detecting_source', 'adapting', 'fetching', 'processing', 'transcribing', 'segmenting', 'embedding', 'extracting', 'generating', 'learning_document_planning', 'learning_document_generating', 'docx_rendering', 'output_ready', 'scanning_files', 'analyzing_files', 'planning_organization', 'awaiting_confirmation', 'creating_directories', 'moving_files', 'review', 'completed', 'failed',
]

export function normalizeFileAnalysisResponse(response: string, canonical: string): string {
  return response
    .replaceAll('<canonical_path>', canonical)
    .replaceAll(`<${canonical}>`, canonical)
    .replace(/<line-(\d+)>/gu, '$1')
    .replace(/<line-(\d+)-(\d+)>/gu, '$1-$2')
    .replaceAll(`${canonical}:<line> `, '')
    .replaceAll(`${canonical}:<line>`, '')
}

export function verifiedPackageRequirements(source: string, canonical: string): string | null {
  let parsed: { packageManager?: unknown; engines?: { node?: unknown } }
  try { parsed = JSON.parse(source) as typeof parsed } catch { return null }
  if (typeof parsed.packageManager !== 'string' || typeof parsed.engines?.node !== 'string') return null
  const lines = source.replace(/\r\n?|\n/gu, '\n').split('\n')
  const packageManagerLine = lines.findIndex((line) => line.includes('"packageManager"')) + 1
  const enginesLine = lines.findIndex((line) => line.includes('"engines"')) + 1
  const nodeLine = lines.findIndex((line, index) => index >= Math.max(0, enginesLine - 1) && line.includes('"node"')) + 1
  if (packageManagerLine < 1 || enginesLine < 1 || nodeLine < enginesLine) return null
  return [
    `${canonical}:${packageManagerLine}: packageManager = ${parsed.packageManager}`,
    `${canonical}:${enginesLine}-${nodeLine}: Node.js = ${parsed.engines.node}`,
    '',
    `当前项目要求使用 ${parsed.packageManager}，Node.js 版本需要满足 ${parsed.engines.node}。`,
  ].join('\n')
}

export class TaskManager {
  private readonly running = new Map<string, { cancel: CancelHandle | null; canceled: boolean }>()
  private readonly listeners = new Map<string, Set<ServerResponse>>()

  constructor(
    readonly database: WorkbenchDatabase,
    readonly artifacts = new ArtifactService(database),
    readonly inputs = new UniversalInputService(database),
  ) {}

  create(input: TaskCreateInput): WorkbenchTask {
    const submitted = input as TaskCreateInput & Record<string, unknown>
    const forbiddenClientFields = ['projectId', 'project_id', 'profile', 'provider', 'command', 'executable', 'shell', 'args', 'env', 'dshHome', 'databasePath']
    if (forbiddenClientFields.some((field) => Object.hasOwn(submitted, field))) throw new Error('CLIENT_EXECUTION_CONTROL_DENIED')
    const template = templateById(input.templateId)
    if (!template.enabled) throw new Error('TEMPLATE_DISABLED')
    if (typeof input.inputValue !== 'string' || input.inputValue.trim().length === 0 || input.inputValue.length > 4096) {
      throw new Error('INVALID_TASK_INPUT')
    }
    if (input.databaseRole !== undefined && !['production', 'test'].includes(input.databaseRole)) throw new Error('INVALID_DATABASE_ROLE')
    let normalized = { ...input, inputValue: input.inputValue.trim() }
    if (input.inputAssetId !== undefined) {
      if (typeof input.inputAssetId !== 'string' || input.inputAssetId.length > 128) throw new Error('INVALID_INPUT_ASSET_ID')
      const selected = this.inputs.get(input.inputAssetId)
      if (selected.asset.task_id !== null) throw new Error('INPUT_ASSET_ALREADY_ATTACHED')
      if (selected.effective_path === null) throw new Error('INPUT_ASSET_PATH_UNAVAILABLE')
      if (input.templateId === 'file-analysis' && selected.asset.input_type !== 'file') throw new Error('INPUT_TYPE_MISMATCH')
      if (input.templateId === 'file-analysis' && !selected.capability.analyzable) throw new Error('INPUT_PARSER_REQUIRED')
      if (input.templateId === 'asset-inventory' && selected.asset.input_type !== 'directory') throw new Error('INPUT_TYPE_MISMATCH')
      normalized = { ...normalized, inputType: selected.asset.input_type, inputValue: selected.effective_path }
    }
    const task = this.database.createTask(randomUUID(), normalized)
    if (input.inputAssetId !== undefined) {
      const selected = this.inputs.attachToTask(input.inputAssetId, task.id, task.projectId)
      this.addEvent(task.id, 'input.asset_created', 'workbench', {
        inputAssetId: selected.asset.id, accessMode: selected.asset.access_mode, sourceMode: selected.asset.source_mode,
      })
      if (selected.grant !== null) {
        this.addEvent(task.id, 'input.grant_created', 'workbench', {
          inputAssetId: selected.asset.id, grantId: selected.grant.grant_id, accessMode: selected.asset.access_mode,
          scope: selected.grant.scope,
        })
        this.addEvent(task.id, 'input.grant_attached', 'workbench', {
          inputAssetId: selected.asset.id, grantId: selected.grant.grant_id, accessMode: selected.asset.access_mode,
        })
      }
      if (selected.asset.access_mode === 'staged_copy') {
        this.addEvent(task.id, 'input.staged', 'workbench', {
          inputAssetId: selected.asset.id, accessMode: selected.asset.access_mode, originalFileModified: false,
        })
      }
    }
    return this.required(task.id)
  }

  async start(id: string): Promise<WorkbenchTask> {
    const task = this.required(id)
    if (!['created', 'failed', 'canceled'].includes(task.status)) throw new Error(`TASK_STATE_CONFLICT: ${task.status}`)
    if (this.running.has(id)) throw new Error('TASK_ALREADY_RUNNING')
    this.transition(id, 'validating', {})
    try {
      await this.validate(task)
    } catch (error) {
      this.transition(id, 'failed', {
        completedAt: now(),
        errorCode: 'TASK_VALIDATION_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      await this.expireTaskInput(task.id)
      throw error
    }
    this.transition(id, 'queued', {})
    const state = { cancel: null as CancelHandle | null, canceled: false }
    this.running.set(id, state)
    void this.execute(this.required(id), state)
    return this.required(id)
  }

  async cancel(id: string): Promise<WorkbenchTask> {
    const task = this.required(id)
    const active = this.running.get(id)
    if (active === undefined) {
      // Learning-document rendering runs after its source task has completed.
      // It deliberately reuses the source task and marks its runtime as running;
      // permit the user to stop that resumable output phase without deleting the
      // already indexed source or its completed document chunks.
      if (task.status === 'completed' && this.runtime(id).status === 'running') {
        this.transition(id, 'canceled', { completedAt: now(), errorCode: 'CANCELED_BY_USER', errorMessage: '用户停止了资料整理，可稍后继续处理。' })
        return this.required(id)
      }
      if (['completed', 'failed', 'canceled'].includes(task.status)) return task
      this.transition(id, 'canceled', { completedAt: now(), errorCode: 'CANCELED_BY_USER', errorMessage: '用户取消了任务。' })
      await this.expireTaskInput(id)
      return this.required(id)
    }
    active.canceled = true
    await active.cancel?.()
    return this.required(id)
  }

  retry(id: string): WorkbenchTask {
    const old = this.required(id)
    if (!['failed', 'canceled', 'completed'].includes(old.status)) throw new Error('TASK_RETRY_CONFLICT')
    const databaseRole = (old.metadata.databaseRole === 'test' ? 'test' : 'production') as DatabaseRole
    if (typeof old.metadata.inputAssetId === 'string') throw new Error('INPUT_RESELECTION_REQUIRED')
    return this.create({
      templateId: old.templateId,
      title: `${old.title} · 重试`,
      inputType: old.inputType,
      inputValue: old.inputValue,
      ...(old.workspacePath === null ? {} : { workspacePath: old.workspacePath }),
      ...(old.projectName === null ? {} : { projectName: old.projectName }),
      databaseRole,
    })
  }

  get(id: string): WorkbenchTask | undefined { return this.database.getTask(id) }
  list(limit?: number, options: { includeInternal?: boolean; includeHidden?: boolean; status?: string | undefined; search?: string | undefined } = {}): WorkbenchTask[] { return this.database.listTasks(limit, options) }
  hide(id: string): WorkbenchTask { return this.database.setTaskHidden(id, true) }
  restore(id: string): WorkbenchTask { return this.database.setTaskHidden(id, false) }
  events(id: string, afterId?: number): TaskEvent[] { return this.database.listEvents(id, afterId) }
  runtime(id: string): TaskRuntimeState {
    this.required(id)
    const runtime = this.database.getTaskRuntime(id)
    if (runtime === undefined) throw new Error('TASK_RUNTIME_NOT_FOUND')
    return runtime
  }

  runtimeView(id: string): TaskRuntimeView {
    const runtime = this.runtime(id)
    const completed = new Set<TaskRuntimeStage>()
    const logs: TaskRuntimeLogEntry[] = []
    let activeTool: string | null = null
    for (const event of this.events(id)) {
      const payload = event.payload as Record<string, unknown>
      if (event.eventType === 'runtime.stage' && typeof payload.current_stage === 'string' && RUNTIME_STAGES.includes(payload.current_stage as TaskRuntimeStage)) {
        completed.add(payload.current_stage as TaskRuntimeStage)
      }
      if (event.eventType === 'runtime.log' && typeof payload.stage === 'string' && typeof payload.message === 'string') {
        logs.push({
          timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : event.createdAt,
          stage: payload.stage as TaskRuntimeStage,
          level: payload.level === 'warning' || payload.level === 'error' ? payload.level : 'info',
          message: payload.message,
        })
      }
      if (event.eventType === 'tool/call') activeTool = toolNameFromPayload(payload) ?? activeTool
      if (event.eventType === 'video.runtime_stage' && typeof payload.tool === 'string') activeTool = payload.tool
      if (event.eventType === 'source.adapter.runtime' && typeof payload.tool === 'string') activeTool = payload.tool
    }
    if (runtime.status === 'completed' || runtime.status === 'failed' || runtime.status === 'canceled') completed.add(runtime.current_stage)
    return { runtime, completed_stages: RUNTIME_STAGES.filter(stage => completed.has(stage)), logs: logs.slice(-200), active_tool: activeTool }
  }

  updateRuntime(id: string, patch: Partial<{
    current_stage: TaskRuntimeStage
    progress: number
    status: TaskRuntimeStatus
    message: string
    started_at: string | null
    finished_at: string | null
    active_model: string | null
  }>): TaskRuntimeState {
    const previous = this.runtime(id)
    const message = patch.message === undefined ? undefined : patch.message.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 600)
    const next = this.database.updateTaskRuntime(id, { ...patch, ...(message === undefined ? {} : { message }) })
    if (previous.current_stage !== next.current_stage) this.addEvent(id, 'runtime.stage', 'workbench', { ...next })
    this.addEvent(id, 'runtime.state', 'workbench', { ...next })
    return next
  }

  runtimeLog(id: string, input: Omit<TaskRuntimeLogEntry, 'timestamp'> & { timestamp?: string }): void {
    this.required(id)
    if (!RUNTIME_STAGES.includes(input.stage)) throw new Error('INVALID_RUNTIME_STAGE')
    const message = input.message.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 1000)
    if (message.length === 0) throw new Error('INVALID_RUNTIME_LOG')
    this.addEvent(id, 'runtime.log', 'workbench', {
      timestamp: input.timestamp ?? now(), stage: input.stage, level: input.level, message,
    })
  }

  recordEvent(id: string, eventType: string, source: 'workbench' | 'harness', payload: unknown): void {
    this.required(id)
    this.addEvent(id, eventType, source, payload)
  }

  startExternal(id: string, input: { stage: TaskRuntimeStage; progress: number; message: string; activeModel?: string | null }): WorkbenchTask {
    const task = this.required(id)
    if (!['created', 'queued', 'starting', 'running'].includes(task.status)) throw new Error(`TASK_STATE_CONFLICT: ${task.status}`)
    if (task.status !== 'running') this.transition(id, 'running', { startedAt: task.startedAt ?? now(), errorCode: null, errorMessage: null })
    this.updateRuntime(id, {
      current_stage: input.stage, progress: input.progress, status: 'running', message: input.message,
      started_at: task.startedAt ?? now(), finished_at: null,
      ...(input.activeModel === undefined ? {} : { active_model: input.activeModel }),
    })
    return this.required(id)
  }

  completeExternal(id: string, input: { resultText: string; metadata: Record<string, unknown> }): WorkbenchTask {
    this.transition(id, 'completed', { completedAt: now(), resultText: input.resultText, metadata: input.metadata })
    return this.required(id)
  }

  /** Restores a source task after the user stopped only its resumable output phase. */
  resumeDocumentOutput(id: string): WorkbenchTask {
    const task = this.required(id)
    if (task.status !== 'canceled') throw new Error('DOCUMENT_RESUME_STATE_CONFLICT')
    this.transition(id, 'completed', {
      completedAt: task.completedAt ?? now(), errorCode: null, errorMessage: null,
      resultText: task.resultText ?? '资料来源已经完成，正在继续整理学习资料。', metadata: task.metadata,
    })
    this.addEvent(id, 'document.resume', 'workbench', { message: '正在恢复资料整理，已完成的资料片段将被复用。' })
    return this.required(id)
  }

  failExternal(id: string, input: { errorCode: string; errorMessage: string }): WorkbenchTask {
    this.transition(id, 'failed', { completedAt: now(), errorCode: input.errorCode, errorMessage: input.errorMessage })
    return this.required(id)
  }

  async monitor(): Promise<RuntimeMonitor> {
    const total = os.totalmem()
    const free = os.freemem()
    const active = this.database.listActiveTaskRuntimes(1)[0] ?? null
    const gpu = { available: false, name: null as string | null, utilization_percent: null as number | null, memory_used_mb: null as number | null, memory_total_mb: null as number | null }
    const executable = nvidiaSmiPath()
    if (executable !== null) {
      try {
        const result = await runProcess(executable, ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 5000 })
        const row = result.stdout.split(/\r?\n/u).find(Boolean)?.split(',').map(value => value.trim()) ?? []
        const utilization = Number(row[1]); const used = Number(row[2]); const totalMemory = Number(row[3])
        gpu.available = result.exitCode === 0 && row.length >= 4
        gpu.name = row[0] ?? null
        gpu.utilization_percent = Number.isFinite(utilization) ? utilization : null
        gpu.memory_used_mb = Number.isFinite(used) ? used : null
        gpu.memory_total_mb = Number.isFinite(totalMemory) ? totalMemory : null
      } catch { /* diagnostics remain available without nvidia-smi */ }
    }
    return {
      captured_at: now(), gpu,
      cpu: { logical_cores: os.cpus().length, load_average_1m: process.platform === 'win32' ? null : os.loadavg()[0] ?? null, process_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
      memory: { total_mb: Math.round(total / 1024 / 1024), used_mb: Math.round((total - free) / 1024 / 1024), free_mb: Math.round(free / 1024 / 1024) },
      active_model: active?.active_model ?? null,
      current_task: active === null ? null : {
        task_id: active.task_id, task_type: active.task_type, current_stage: active.current_stage,
        progress: active.progress, status: active.status, message: active.message,
      },
    }
  }

  async releaseExternalInput(id: string): Promise<void> { await this.expireTaskInput(id) }

  async saveAnswerAsReport(id: string, options: {
    auto_link_task?: boolean
    auto_link_session?: boolean
    evidence?: ArtifactEvidenceCreateInput[]
  } = {}): Promise<TaskReportCandidateResult> {
    let task = this.required(id)
    const resultText = task.resultText
    if (task.status !== 'completed' || resultText === null || resultText.trim().length === 0) {
      throw new Error('TASK_RESULT_NOT_AVAILABLE')
    }
    task = await this.ensureReportTaskContext(task)
    if (task.projectId === null || task.workspacePath === null) throw new Error('PERSONAL_INBOX_BIND_FAILED')
    const project = this.database.getProjectContext(task.projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const workspace = await assertAllowedExisting(task.workspacePath, 'directory')
    if (!artifactBelongsToRoot(workspace, project.rootPath)) throw new Error('ARTIFACT_PROJECT_PATH_DENIED')
    const proposedOutput = path.resolve(workspace, 'output')
    if (!artifactBelongsToRoot(proposedOutput, workspace) || !artifactBelongsToRoot(proposedOutput, project.rootPath)) {
      throw new Error('ARTIFACT_PROJECT_PATH_DENIED')
    }
    await mkdir(proposedOutput, { recursive: true })
    const outputRoot = await assertAllowedExisting(proposedOutput, 'directory')
    if (!artifactBelongsToRoot(outputRoot, workspace) || !artifactBelongsToRoot(outputRoot, project.rootPath)) {
      throw new Error('ARTIFACT_PROJECT_PATH_DENIED')
    }
    const stamp = new Date().toISOString().replace(/\D/gu, '').slice(0, 14)
    const fileName = `task-${task.id.slice(0, 8)}-answer-${stamp}-${randomUUID().slice(0, 8)}.md`
    const filePath = path.join(outputRoot, fileName)
    const title = task.title.replace(/[\r\n]+/gu, ' ').slice(0, 160)
    const createdAt = new Date().toISOString()
    const content = [
      `# ${title}`,
      '',
      `- Workbench Task: ${task.id}`,
      `- Generated At: ${createdAt}`,
      '',
      '## 回答',
      '',
      resultText.trim(),
      '',
    ].join('\n')
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
    const canonical = await assertAllowedExisting(filePath, 'file')
    const information = await stat(canonical)
    const candidate = {
      project_id: project.id,
      task_id: task.id,
      artifact_type: 'report' as const,
      name: fileName,
      relative_path: path.relative(project.rootPath, canonical),
      absolute_path: canonical,
      mime_type: artifactMimeType(canonical),
      size_bytes: information.size,
      modified_at: information.mtime.toISOString(),
      registered_artifact_id: null,
    }
    const retained = task.artifactIndex.filter(item => item === null || typeof item !== 'object' || (item as Record<string, unknown>).absolute_path !== canonical)
    this.database.updateTask(task.id, { artifactIndex: [...retained, candidate] })
    const artifact = await this.artifacts.register({
      project_id: project.id,
      task_id: task.id,
      file_path: canonical,
      artifact_type: 'report',
      name: fileName,
      metadata: { origin: 'task-answer-report', generated_at: createdAt },
      auto_link_task: options.auto_link_task ?? true,
      auto_link_session: options.auto_link_session ?? true,
      ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    })
    const registeredCandidate = { ...candidate, registered_artifact_id: artifact.id }
    this.addEvent(task.id, 'artifact.report_saved', 'workbench', {
      artifactId: artifact.id,
      name: candidate.name,
      relativePath: candidate.relative_path,
      sizeBytes: candidate.size_bytes,
      artifactRegistered: true,
    })
    return {
      candidate: registeredCandidate,
      file_created: true,
      artifact_registered: true,
      artifact,
      evidence_count: this.database.listArtifactEvidenceLinks(artifact.id).length,
    }
  }

  async exportAnswerAsWord(id: string, options: {
    auto_link_task?: boolean
    auto_link_session?: boolean
    evidence?: ArtifactEvidenceCreateInput[]
  } = {}): Promise<TaskWordExportResult> {
    let task = this.required(id)
    if (task.status !== 'completed' || task.resultText === null || task.resultText.trim().length === 0) throw new Error('TASK_RESULT_NOT_AVAILABLE')
    let markdownArtifact = this.artifacts.query({ task_id: task.id, artifact_type: 'report', limit: 200 })
      .find(artifact => artifact.mime_type === 'text/markdown' && artifact.metadata.origin === 'task-answer-report')
    if (markdownArtifact === undefined) markdownArtifact = (await this.saveAnswerAsReport(id, options)).artifact

    task = this.required(id)
    task = await this.ensureReportTaskContext(task)
    if (task.projectId === null || task.workspacePath === null) throw new Error('PERSONAL_INBOX_BIND_FAILED')
    const project = this.database.getProjectContext(task.projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const markdown = await readFile(markdownArtifact.absolute_path, 'utf8')
    const outputRoot = await assertAllowedExisting(path.dirname(markdownArtifact.absolute_path), 'directory')
    if (!artifactBelongsToRoot(outputRoot, task.workspacePath) || !artifactBelongsToRoot(outputRoot, project.rootPath)) throw new Error('ARTIFACT_PROJECT_PATH_DENIED')
    const stamp = new Date().toISOString().replace(/\D/gu, '').slice(0, 14)
    const fileName = `task-${task.id.slice(0, 8)}-answer-${stamp}-${randomUUID().slice(0, 8)}.docx`
    const filePath = path.join(outputRoot, fileName)
    const document = createDocxFromMarkdown(markdown, task.title)
    validateDocx(document)
    await writeFile(filePath, document, { flag: 'wx' })
    const canonical = await assertAllowedExisting(filePath, 'file')
    const artifact = await this.artifacts.register({
      project_id: project.id,
      task_id: task.id,
      file_path: canonical,
      artifact_type: 'report',
      name: fileName,
      metadata: { origin: 'task-answer-word-export', markdown_artifact_id: markdownArtifact.id, generated_at: new Date().toISOString() },
      auto_link_task: options.auto_link_task ?? true,
      auto_link_session: options.auto_link_session ?? true,
      evidence: [
        { source_type: 'artifact', source_id: markdownArtifact.id, relation_type: 'derived_from' },
        ...(options.evidence ?? []),
      ],
    })
    this.addEvent(task.id, 'artifact.word_exported', 'workbench', {
      artifactId: artifact.id, markdownArtifactId: markdownArtifact.id, name: artifact.name, artifactRegistered: true,
    })
    return {
      markdown_artifact: markdownArtifact,
      word_artifact: artifact,
      word_path: artifact.absolute_path,
      evidence_count: this.database.listArtifactEvidenceLinks(artifact.id).length,
    }
  }

  attachSse(taskId: string, response: ServerResponse): void {
    this.required(taskId)
    let set = this.listeners.get(taskId)
    if (set === undefined) { set = new Set(); this.listeners.set(taskId, set) }
    set.add(response)
    for (const event of this.events(taskId)) response.write(`id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`)
    const timer = setInterval(() => response.write(': heartbeat\n\n'), 15000)
    response.once('close', () => { clearInterval(timer); set?.delete(response) })
  }

  private required(id: string): WorkbenchTask {
    const task = this.database.getTask(id)
    if (task === undefined) throw new Error('TASK_NOT_FOUND')
    return task
  }

  private async ensureReportTaskContext(task: WorkbenchTask): Promise<WorkbenchTask> {
    if (task.projectId !== null && task.workspacePath !== null) return task
    const inbox = this.database.getPersonalInboxProject()
    if (inbox === undefined) throw new Error('PERSONAL_INBOX_NOT_AVAILABLE')
    await mkdir(inbox.rootPath, { recursive: true })
    const workspace = await assertAllowedExisting(inbox.rootPath, 'directory')
    const bound = this.database.bindTaskToProject(task.id, inbox.id, workspace)
    this.addEvent(task.id, 'task.project_context_assigned', 'workbench', {
      projectId: inbox.id,
      projectName: inbox.name,
      workspacePath: workspace,
      reason: 'personal-inbox-fallback',
    })
    return bound
  }

  private addEvent(id: string, eventType: string, source: 'workbench' | 'harness', payload: unknown): void {
    const event = this.database.addEvent(id, eventType, source, payload)
    for (const listener of this.listeners.get(id) ?? []) listener.write(`id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  private transition(id: string, status: WorkbenchTask['status'], patch: Parameters<WorkbenchDatabase['updateTask']>[1]): void {
    this.database.updateTask(id, { ...patch, status })
    this.addEvent(id, `task.${status}`, 'workbench', { status, ...patch })
    const current = this.runtime(id)
    const map: Record<WorkbenchTask['status'], { stage: TaskRuntimeStage; progress: number; runtimeStatus: TaskRuntimeStatus; message: string }> = {
      created: { stage: 'created', progress: 0, runtimeStatus: 'created', message: '任务已经创建。' },
      validating: { stage: 'initializing', progress: 5, runtimeStatus: 'running', message: '正在检查任务输入与访问权限。' },
      queued: { stage: 'initializing', progress: 12, runtimeStatus: 'running', message: '任务已经进入执行队列。' },
      starting: { stage: 'initializing', progress: 18, runtimeStatus: 'running', message: '正在初始化本地运行环境。' },
      running: { stage: 'processing', progress: Math.max(25, current.progress), runtimeStatus: 'running', message: '任务正在处理。' },
      completed: { stage: 'completed', progress: 100, runtimeStatus: 'completed', message: '任务已经完成。' },
      failed: { stage: 'failed', progress: current.progress, runtimeStatus: 'failed', message: typeof patch.errorMessage === 'string' ? patch.errorMessage : '任务执行失败。' },
      canceled: { stage: 'failed', progress: current.progress, runtimeStatus: 'canceled', message: '任务已由用户取消。' },
    }
    const mapped = map[status]
    this.updateRuntime(id, {
      current_stage: mapped.stage, progress: mapped.progress, status: mapped.runtimeStatus, message: mapped.message,
      ...(status === 'validating' || status === 'starting' ? { started_at: patch.startedAt ?? current.started_at ?? now(), finished_at: null } : {}),
      ...(['completed', 'failed', 'canceled'].includes(status) ? { finished_at: patch.completedAt ?? now(), active_model: null } : {}),
    })
  }

  private async validate(task: WorkbenchTask): Promise<void> {
    templateById(task.templateId)
    if (task.profile.length > 0 && !(task.profile in PROFILE_ALLOWLIST)) throw new Error('PROFILE_NOT_ALLOWED')
    if (task.workspacePath !== null) await this.assertProjectOrPermanent(task, task.workspacePath, 'directory')
    const inputAssetId = typeof task.metadata.inputAssetId === 'string' ? task.metadata.inputAssetId : null
    if (task.templateId === 'file-analysis') {
      if (inputAssetId === null) await this.assertProjectOrPermanent(task, task.inputValue, 'file')
      else await this.inputs.assertTaskAccess(task.id, inputAssetId, task.inputValue, 'file')
    }
    if (task.templateId === 'asset-inventory') {
      if (inputAssetId === null) await this.assertProjectOrPermanent(task, task.inputValue, 'directory')
      else await this.inputs.assertTaskAccess(task.id, inputAssetId, task.inputValue, 'directory')
    }
    if (task.templateId === 'video-to-knowledge' && /^[A-Za-z]:[\\/]/u.test(task.inputValue)) {
      await assertAllowedExisting(task.inputValue, 'file')
    }
  }

  private async execute(task: WorkbenchTask, state: { cancel: CancelHandle | null; canceled: boolean }): Promise<void> {
    const startedAt = now()
    this.transition(task.id, 'starting', { startedAt })
    try {
      const template = templateById(task.templateId as TemplateId)
      if (template.execution === 'deterministic') {
        this.transition(task.id, 'running', {})
        this.updateRuntime(task.id, { current_stage: 'processing', progress: 45, status: 'running', message: '正在统计文件与目录。', active_model: null })
        const inputAssetId = typeof task.metadata.inputAssetId === 'string' ? task.metadata.inputAssetId : null
        const authorizedRoot = inputAssetId === null ? undefined : await this.inputs.assertTaskAccess(task.id, inputAssetId, task.inputValue, 'directory')
        const inventory = await collectAssetInventory(task.inputValue, authorizedRoot === undefined ? {} : { authorizedRoot })
        const text = `资产统计完成：${inventory.fileCount} 个文件，${inventory.directoryCount} 个目录，总容量 ${inventory.totalBytes} 字节。`
        await this.refreshArtifactCandidates(task.id)
        this.transition(task.id, 'completed', {
          completedAt: now(), resultText: text,
          metadata: { ...task.metadata, execution: 'deterministic', inventory },
        })
        return
      }
      if (template.execution === 'planned') {
        this.transition(task.id, 'running', {})
        this.updateRuntime(task.id, { current_stage: 'generating', progress: 60, status: 'running', message: '正在生成计划任务说明。', active_model: null })
        const resultText = '任务已经登记为 planned。当前版本展示受控流水线与旧工程审计信息，媒体处理模块尚未启用。'
        await this.refreshArtifactCandidates(task.id)
        this.transition(task.id, 'completed', {
          completedAt: now(), resultText,
          metadata: { ...task.metadata, execution: 'planned', videoState: 'CREATED', mediaPipelineEnabled: false },
        })
        return
      }
      if (template.execution === 'video') {
        this.transition(task.id, 'running', {})
        this.transition(task.id, 'completed', {
          completedAt: now(),
          resultText: '视频知识任务需要通过 /api/video/jobs 创建，以便应用路径策略、媒体适配器、Artifact 与审核门禁。',
          metadata: { ...task.metadata, execution: 'video-api-required' },
        })
        return
      }
      this.transition(task.id, 'running', {})
      this.updateRuntime(task.id, { current_stage: 'processing', progress: 30, status: 'running', message: '本地模型正在分析任务。', active_model: PATHS.modelName })
      const inputAssetId = typeof task.metadata.inputAssetId === 'string' ? task.metadata.inputAssetId : null
      const projectRoot = task.projectId === null ? null : this.database.getProjectContext(task.projectId)?.rootPath ?? null
      const inputPolicyOverlay = await this.inputs.createTaskPolicyOverlay(task.id, inputAssetId, projectRoot)
      const { result, durationMs } = await runHarnessTask(task, {
        registerCancel: close => { state.cancel = close },
        onReady: ({ sessionId, runtimePid }) => {
          this.database.updateTask(task.id, { harnessSessionId: sessionId, runtimePid })
          this.addEvent(task.id, 'harness.ready', 'workbench', { sessionId, runtimePid, profile: task.profile })
          this.updateRuntime(task.id, { current_stage: 'processing', progress: 38, status: 'running', message: '模型会话已经创建，正在执行工具调用。', active_model: PATHS.modelName })
        },
        onNotification: notification => {
          const safe = sanitizeHarnessNotification(notification)
          if (shouldPersistHarnessNotification(safe)) {
            this.addEvent(task.id, harnessEventType(safe), 'harness', safe)
            const type = harnessEventType(safe)
            if (type === 'tool/call') this.runtimeLog(task.id, { stage: 'processing', level: 'info', message: '正在调用本机工具。' })
            if (type === 'tool/result') this.updateRuntime(task.id, { current_stage: 'generating', progress: 78, status: 'running', message: '工具结果已经返回，正在整理回答。', active_model: PATHS.modelName })
          }
        },
      }, { inputPolicyOverlay })
      if (state.canceled) {
        this.transition(task.id, 'canceled', { completedAt: now(), errorCode: 'CANCELED_BY_USER', errorMessage: '用户取消了任务。' })
        return
      }
      let finalResponse = result.finalResponse
      if (task.templateId === 'file-analysis') {
        const canonical = inputAssetId === null
          ? await this.assertProjectOrPermanent(task, task.inputValue, 'file')
          : await this.inputs.assertTaskAccess(task.id, inputAssetId, task.inputValue, 'file')
        finalResponse = normalizeFileAnalysisResponse(finalResponse, canonical)
        if (path.basename(canonical).toLowerCase() === 'package.json') {
          finalResponse = verifiedPackageRequirements(await readFile(canonical, 'utf8'), canonical) ?? finalResponse
        }
      }
      if (finalResponse.trim().length === 0) throw new Error('HARNESS_EMPTY_RESULT')
      await this.refreshArtifactCandidates(task.id)
      this.transition(task.id, 'completed', {
        completedAt: now(),
        harnessSessionId: result.sessionId,
        resultText: finalResponse,
        citationIndex: extractCitations(finalResponse),
        metadata: {
          ...task.metadata,
          execution: 'official-sdk', provider: 'ollama-local', model: PATHS.modelName, contextWindow: 8192,
          maxTokens: 512, endpoint: PATHS.ollamaEndpoint, sdkDurationMs: Math.round(durationMs * 1000) / 1000,
          eventCount: result.events.length,
        },
      })
    } catch (error) {
      const canceled = state.canceled
      this.transition(task.id, canceled ? 'canceled' : 'failed', {
        completedAt: now(),
        errorCode: canceled ? 'CANCELED_BY_USER' : 'TASK_EXECUTION_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await this.expireTaskInput(task.id)
      this.running.delete(task.id)
      state.cancel = null
    }
  }

  private async expireTaskInput(taskId: string): Promise<void> {
    const expired = await this.inputs.expireForTask(taskId)
    for (const grant of expired) {
      this.addEvent(taskId, 'input.grant_expired', 'workbench', {
        inputAssetId: grant.input_asset_id, grantId: grant.grant_id, accessMode: 'temporary_grant',
      })
    }
  }

  private async assertProjectOrPermanent(task: WorkbenchTask, inputPath: string, expected: 'file' | 'directory'): Promise<string> {
    if (task.projectId === null) return assertAllowedExisting(inputPath, expected)
    const project = this.database.getProjectContext(task.projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const [canonical, root] = await Promise.all([realpath(path.resolve(inputPath)), realpath(project.rootPath)])
    if (!artifactBelongsToRoot(canonical, root)) throw new Error('PATH_POLICY_DENIED')
    const information = await stat(canonical)
    if (expected === 'file' && !information.isFile()) throw new Error('PATH_TYPE_MISMATCH')
    if (expected === 'directory' && !information.isDirectory()) throw new Error('PATH_TYPE_MISMATCH')
    return canonical
  }

  private async refreshArtifactCandidates(taskId: string): Promise<void> {
    try {
      const candidates = await this.artifacts.discoverTaskCandidates(taskId)
      this.database.updateTask(taskId, { artifactIndex: candidates })
      this.addEvent(taskId, 'artifact.candidates', 'workbench', {
        count: candidates.length,
        files: candidates.slice(0, 20).map(candidate => candidate.relative_path),
      })
    } catch (error) {
      this.addEvent(taskId, 'artifact.discovery_failed', 'workbench', {
        errorCode: error instanceof Error ? error.message.split(':')[0] : 'ARTIFACT_DISCOVERY_FAILED',
      })
    }
  }
}
