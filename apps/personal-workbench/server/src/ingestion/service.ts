import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DetectedKnowledgeSource, KnowledgeIngestionInput, KnowledgeIngestionPipeline, KnowledgeIngestionRecord, KnowledgeIngestionResult, LearningDocumentMode, UnifiedDocumentRecord, WorkbenchTask } from '../../../shared/contracts/index.ts'
import { ArtifactService } from '../artifacts/service.ts'
import { WorkbenchDatabase } from '../database.ts'
import { DocumentSearchService } from '../documents/search-service.ts'
import type { LearningDocumentService } from '../learning/service.ts'
import { SourceAdapterRegistry } from '../sources/registry.ts'
import { SourceAdapterError, type AdapterRuntime } from '../sources/types.ts'
import { TaskManager } from '../tasks/manager.ts'
import { VideoKnowledgeService } from '../video/service.ts'
import { documentSubtypeForFile, mediaInputTypeForFile, SourceDetector } from './source-detector.ts'

function now(): string { return new Date().toISOString() }

function sourceTitle(source: DetectedKnowledgeSource, title?: string): string {
  const requested = typeof title === 'string' ? title.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 160) : ''
  return requested.length > 0 ? requested : `知识导入 · ${source.display_name}`.slice(0, 180)
}

function adapterPipeline(pipeline: KnowledgeIngestionPipeline): pipeline is 'web_knowledge' | 'github_knowledge' | 'document_knowledge' {
  return pipeline === 'web_knowledge' || pipeline === 'github_knowledge' || pipeline === 'document_knowledge'
}

function preferredMode(source: DetectedKnowledgeSource, input: KnowledgeIngestionInput): LearningDocumentMode {
  if (input.document_mode === 'review_notes' || input.document_mode === 'technical_guide' || input.document_mode === 'simple_summary' || input.document_mode === 'learning_notes') return input.document_mode
  return source.source_type === 'github_repo' ? 'technical_guide' : 'learning_notes'
}

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof SourceAdapterError) return { code: error.code, message: error.userMessage }
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('LEARNING_DOCUMENT_')) return { code: 'LEARNING_DOCUMENT_FAILED', message: '来源正文已保留，但学习资料或 Word 文档暂时没有完成，可以在任务详情重新生成。' }
  return { code: 'KNOWLEDGE_SOURCE_ADAPTER_FAILED', message: '读取公开来源时出现问题，当前任务没有生成内容；你可以检查链接后重试。' }
}

function sourceDocumentJson(document: UnifiedDocumentRecord): string {
  return `${JSON.stringify({ schema: 'personal-workbench.unified-document.v1', ...document }, null, 2)}\n`
}

function repositoryManifest(document: UnifiedDocumentRecord): string {
  const metadata = document.metadata
  return `${JSON.stringify({
    schema: 'personal-workbench.repository-manifest.v1', title: document.title, repository_url: document.canonical_url,
    branch: metadata.branch ?? null, repository_commit: metadata.repository_commit ?? null, technologies: metadata.technologies ?? [],
    selected_files: metadata.selected_files ?? [], file_count: metadata.file_count ?? 0, ignored_count: metadata.ignored_count ?? 0,
    binary_count: metadata.binary_count ?? 0, partial: metadata.partial === true,
  }, null, 2)}\n`
}

export class KnowledgeIngestionService {
  readonly detector: SourceDetector
  readonly adapters: SourceAdapterRegistry
  readonly documentSearch: DocumentSearchService

  constructor(
    readonly database: WorkbenchDatabase,
    readonly tasks: TaskManager,
    readonly video: VideoKnowledgeService,
    readonly artifacts = new ArtifactService(database),
    readonly learningDocuments?: LearningDocumentService,
    adapters?: SourceAdapterRegistry,
  ) {
    this.detector = new SourceDetector(tasks.inputs)
    this.adapters = adapters ?? new SourceAdapterRegistry()
    this.documentSearch = new DocumentSearchService(database)
  }

  detect(input: KnowledgeIngestionInput): DetectedKnowledgeSource { return this.detector.detect(input) }

  async ingest(input: KnowledgeIngestionInput): Promise<KnowledgeIngestionResult> {
    const source = this.detect(input)
    const pipeline = this.pipelineFor(source)
    const project = input.project_id === undefined ? this.database.getPersonalInboxProject() : this.database.getProjectContext(input.project_id)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')

    // Before a remote task becomes visible, validate the explicit user URL and
    // its current DNS target. Acquisition repeats this validation for every
    // redirect, so this is an early rejection rather than a widening of access.
    if (adapterPipeline(pipeline)) {
      const adapter = this.adapters.forSource(source)
      if (adapter === undefined) throw new SourceAdapterError('SOURCE_ADAPTER_UNAVAILABLE', '当前版本没有可用于该链接的公开来源适配器。')
      await adapter.inspect(source)
    }

    if (pipeline === 'video_knowledge') {
      const inputType = source.source_type === 'video_url' ? 'url' : mediaInputTypeForFile(source.source_reference)
      if (inputType === null) throw new Error('VIDEO_SOURCE_ADAPTER_UNAVAILABLE')
      const job = this.video.create({ project_id: project.id, input_type: inputType, input_value: source.source_reference, ...(input.input_asset_id === undefined ? {} : { input_asset_id: input.input_asset_id }), title: sourceTitle(source, input.title) })
      if (job.task_id === null) throw new Error('INGESTION_TASK_NOT_CREATED')
      const task = this.prepareTask(job.task_id, source, project.id, pipeline)
      this.tasks.updateRuntime(task.id, { current_stage: 'adapting', progress: 10, status: 'running', message: '已选择本机视频知识处理链路。', active_model: null })
      this.tasks.runtimeLog(task.id, { stage: 'adapting', level: 'info', message: `来源已适配为 ${inputType} 媒体输入。` })
      this.video.start(job.id)
      return { source, ingestion: this.database.getKnowledgeIngestionSourceByTask(task.id)!, task: this.database.getTask(task.id)!, video_job: this.video.repository.getJob(job.id)!, message: '来源已经进入 Video Knowledge 本机处理链路。' }
    }

    const task = this.createTask(source, input, project.id, project.rootPath, pipeline)
    const ingestion = this.database.createKnowledgeIngestionSource({ id: randomUUID(), task_id: task.id, project_id: task.projectId, source_type: source.source_type, source_reference: source.source_reference, display_name: source.display_name, pipeline, metadata: source.metadata, created_at: now() })

    // File and folder tasks are handed to TaskManager.start(), which owns their
    // validating → queued → running lifecycle. Starting an external runtime here
    // first would make the subsequent start call reject the task as already running.
    if (pipeline === 'file_analysis' || pipeline === 'folder_inventory') {
      this.tasks.recordEvent(task.id, 'ingestion.source.detected', 'workbench', { ingestionId: ingestion.id, sourceType: source.source_type, pipeline, sourceReference: source.source_reference, userInstruction: source.metadata.user_instruction ?? null })
      this.tasks.runtimeLog(task.id, { stage: 'detecting_source', level: 'info', message: `正在检查 ${source.display_name} 的处理方式。` })
      await this.tasks.start(task.id)
      return { source, ingestion, task: this.database.getTask(task.id)!, video_job: null, message: `来源已经进入${this.pipelineLabel(pipeline)}。` }
    }

    this.tasks.startExternal(task.id, { stage: 'detecting_source', progress: 4, message: `已识别来源：${source.source_type}。`, activeModel: null })
    this.tasks.recordEvent(task.id, 'ingestion.source.detected', 'workbench', { ingestionId: ingestion.id, sourceType: source.source_type, pipeline, sourceReference: source.source_reference, userInstruction: source.metadata.user_instruction ?? null })
    this.tasks.runtimeLog(task.id, { stage: 'detecting_source', level: 'info', message: `正在检查 ${source.display_name} 的处理方式。` })

    if (adapterPipeline(pipeline)) {
      this.tasks.updateRuntime(task.id, { current_stage: 'adapting', progress: 10, status: 'running', message: `正在适配${this.pipelineLabel(pipeline)}。`, active_model: null })
      const adapterId = pipeline === 'github_knowledge' ? 'github' : pipeline === 'document_knowledge' ? 'document' : 'web'
      this.tasks.recordEvent(task.id, 'ingestion.pipeline.adapted', 'workbench', { ingestionId: ingestion.id, pipeline, adapter: adapterId })
      void this.runRemoteAdapter(task.id, project.id, project.rootPath, source, ingestion, preferredMode(source, input))
      const label = pipeline === 'github_knowledge' ? ' GitHub 项目' : pipeline === 'document_knowledge' ? '本机文档' : '网页'
      return { source, ingestion, task: this.database.getTask(task.id)!, video_job: null, message: `正在读取${label}，运行过程会显示在任务面板中。` }
    }

    this.tasks.updateRuntime(task.id, { current_stage: 'processing', progress: 42, status: 'running', message: '正在登记当前可用的知识输入信息。', active_model: null })
    const registration = source.source_type === 'text_input' ? '文本输入已登记为本机知识来源；后续可以在受控文本处理任务中继续使用。' : '来源已登记。'
    this.tasks.runtimeLog(task.id, { stage: 'processing', level: 'info', message: registration })
    const current = this.database.getTask(task.id)
    this.tasks.completeExternal(task.id, { resultText: registration, metadata: { ...current?.metadata, execution: 'knowledge-source-registration', ingestionId: ingestion.id, sourceType: source.source_type, pipeline } })
    this.tasks.recordEvent(task.id, 'ingestion.completed', 'workbench', { ingestionId: ingestion.id, sourceType: source.source_type, pipeline })
    return { source, ingestion, task: this.database.getTask(task.id)!, video_job: null, message: registration }
  }

  get(id: string): KnowledgeIngestionRecord {
    const record = this.database.getKnowledgeIngestionSource(id)
    if (record === undefined) throw new Error('KNOWLEDGE_INGESTION_NOT_FOUND')
    return record
  }

  list(projectId?: string): KnowledgeIngestionRecord[] { return this.database.listKnowledgeIngestionSources(projectId) }
  documentForIngestion(id: string): UnifiedDocumentRecord | undefined { return this.database.getUnifiedDocumentByTask(this.get(id).task_id) }
  async adapterHealth() { return this.adapters.health() }

  private async runRemoteAdapter(taskId: string, projectId: string, projectRoot: string, source: DetectedKnowledgeSource, ingestion: KnowledgeIngestionRecord, mode: LearningDocumentMode): Promise<void> {
    try {
      const adapter = this.adapters.forSource(source)
      if (adapter === undefined) throw new SourceAdapterError('SOURCE_ADAPTER_UNAVAILABLE', '当前版本没有可用于该链接的公开来源适配器。')
      const document = await adapter.acquire(source, { taskId, projectId, report: runtime => this.reportAdapterRuntime(taskId, runtime) })
      const cached = this.database.findUnifiedDocumentByIdentity(projectId, document.canonical_url, document.content_sha256)
      const artifacts = await this.persistSourceArtifacts(document, projectRoot)
      const stored = this.database.createUnifiedDocument({ ...document, metadata: { ...document.metadata, source_artifact_ids: artifacts, ...(cached === undefined ? {} : { cache_reused_from_document_id: cached.id }) } })
      this.tasks.recordEvent(taskId, 'source.unified_document.created', 'workbench', { ingestionId: ingestion.id, unifiedDocumentId: stored.id, adapter: adapter.id, canonicalUrl: stored.canonical_url, contentSha256: stored.content_sha256, cachedFromDocumentId: cached?.id ?? null })
      this.tasks.updateRuntime(taskId, { current_stage: 'generating', progress: 72, status: 'running', message: '来源内容已整理，正在生成学习资料。', active_model: null })
      const material = stored.source_type === 'github_repo' ? '项目技术资料' : stored.source_type === 'local_file' ? '文档学习资料' : '网页学习资料'
      this.tasks.runtimeLog(taskId, { stage: 'generating', level: 'info', message: `${material}的来源产物已登记。` })
      if (stored.source_type === 'local_file') {
        this.tasks.updateRuntime(taskId, { current_stage: 'embedding', progress: 68, status: 'running', message: '正在建立本地资料索引。', active_model: null })
        const indexed = await this.documentSearch.index(stored)
        this.tasks.recordEvent(taskId, 'document.search.indexed', 'workbench', { unifiedDocumentId: stored.id, chunks: indexed.indexed, provider: indexed.provider, model: indexed.model, fallback: indexed.fallback })
        this.tasks.runtimeLog(taskId, { stage: 'embedding', level: 'info', message: `已为 ${indexed.indexed} 个资料片段建立本地索引。` })
      }
      const task = this.database.getTask(taskId)
      this.tasks.completeExternal(taskId, { resultText: this.completedMessage(stored), metadata: { ...task?.metadata, execution: 'knowledge-source-adapter', ingestionId: ingestion.id, sourceType: source.source_type, pipeline: ingestion.pipeline, unifiedDocumentId: stored.id, documentMode: mode } })
      this.tasks.recordEvent(taskId, 'ingestion.completed', 'workbench', { ingestionId: ingestion.id, unifiedDocumentId: stored.id, adapter: adapter.id })
      if (this.learningDocuments !== undefined) {
        this.tasks.runtimeLog(taskId, { stage: 'learning_document_planning', level: 'info', message: '正在依据已提取内容组织学习资料。' })
        try {
          await this.learningDocuments.generate({ task_id: taskId, document_mode: mode })
        } catch (error) {
          // Source acquisition has already completed successfully. Preserve its
          // artifacts and keep this task retriable when the optional document pass
          // cannot obtain a local model or render a DOCX file.
          const resolved = failure(error)
          this.tasks.runtimeLog(taskId, { stage: 'output_ready', level: 'warning', message: `来源内容已保留；学习资料暂未生成：${resolved.message}` })
          this.tasks.recordEvent(taskId, 'learning_document.auto_generation_failed', 'workbench', { ingestionId: ingestion.id, errorCode: resolved.code })
        }
      }
    } catch (error) {
      const resolved = failure(error)
      this.tasks.runtimeLog(taskId, { stage: 'failed', level: 'error', message: resolved.message })
      this.tasks.failExternal(taskId, { errorCode: resolved.code, errorMessage: resolved.message })
      this.tasks.recordEvent(taskId, 'ingestion.failed', 'workbench', { ingestionId: ingestion.id, errorCode: resolved.code })
    } finally {
      // A native-picker grant is only needed while a local document is copied into
      // controlled Artifacts. The generated UnifiedDocument and output files stay
      // available after this point; the original input remains untouched.
      if (ingestion.pipeline === 'document_knowledge') await this.tasks.releaseExternalInput(taskId).catch(() => undefined)
    }
  }

  private reportAdapterRuntime(taskId: string, runtime: AdapterRuntime): void {
    this.tasks.updateRuntime(taskId, { current_stage: runtime.stage, progress: runtime.progress, status: 'running', message: runtime.message, active_model: null })
    this.tasks.runtimeLog(taskId, { stage: runtime.stage, level: runtime.level ?? 'info', message: runtime.message })
    this.tasks.recordEvent(taskId, 'source.adapter.runtime', 'workbench', runtime)
  }

  private async persistSourceArtifacts(document: UnifiedDocumentRecord, projectRoot: string): Promise<string[]> {
    const directory = path.join(projectRoot, 'output', document.task_id, 'source-adapter')
    await mkdir(directory, { recursive: true })
    const sourceName = document.source_type === 'github_repo' ? 'repository-manifest.json' : document.source_type === 'local_file' ? 'document-manifest.json' : 'source-document.json'
    const contentName = document.source_type === 'github_repo' ? 'repository-content.md' : document.source_type === 'local_file' ? 'document-content.md' : 'clean-content.md'
    const sourcePath = path.join(directory, sourceName)
    const contentPath = path.join(directory, contentName)
    await writeFile(sourcePath, document.source_type === 'github_repo' ? repositoryManifest(document) : sourceDocumentJson(document), { encoding: 'utf8', flag: 'wx' })
    await writeFile(contentPath, `${document.content}\n`, { encoding: 'utf8', flag: 'wx' })
    const sourceArtifact = await this.artifacts.register({ project_id: document.project_id, task_id: document.task_id, file_path: sourcePath, artifact_type: 'analysis', name: sourceName, metadata: { origin: 'knowledge-source-adapter', source_type: document.source_type, canonical_url: document.canonical_url, repository_commit: document.metadata.repository_commit ?? null, status: 'staged' }, auto_link_task: true, auto_link_session: true })
    const contentArtifact = await this.artifacts.register({ project_id: document.project_id, task_id: document.task_id, file_path: contentPath, artifact_type: document.source_type === 'github_repo' ? 'code' : 'document', name: contentName, metadata: { origin: 'knowledge-source-adapter', source_type: document.source_type, canonical_url: document.canonical_url, repository_commit: document.metadata.repository_commit ?? null, status: 'staged' }, auto_link_task: true, auto_link_session: true, evidence: [{ source_type: 'artifact', source_id: sourceArtifact.id, relation_type: 'derived_from' }] })
    return [sourceArtifact.id, contentArtifact.id]
  }

  private prepareTask(taskId: string, source: DetectedKnowledgeSource, projectId: string, pipeline: KnowledgeIngestionPipeline): WorkbenchTask {
    const task = this.database.getTask(taskId)
    if (task === undefined) throw new Error('INGESTION_TASK_NOT_CREATED')
    const ingestion = this.database.createKnowledgeIngestionSource({ id: randomUUID(), task_id: task.id, project_id: projectId, source_type: source.source_type, source_reference: source.source_reference, display_name: source.display_name, pipeline, metadata: source.metadata, created_at: now() })
    this.tasks.startExternal(task.id, { stage: 'detecting_source', progress: 4, message: `已识别来源：${source.source_type}。`, activeModel: null })
    this.tasks.recordEvent(task.id, 'ingestion.source.detected', 'workbench', { ingestionId: ingestion.id, sourceType: source.source_type, pipeline, sourceReference: source.source_reference })
    this.tasks.runtimeLog(task.id, { stage: 'detecting_source', level: 'info', message: `正在检查 ${source.display_name} 的处理方式。` })
    return task
  }

  private createTask(source: DetectedKnowledgeSource, input: KnowledgeIngestionInput, projectId: string, workspacePath: string, pipeline: KnowledgeIngestionPipeline): WorkbenchTask {
    const templateId = pipeline === 'file_analysis' ? 'file-analysis' : pipeline === 'folder_inventory' ? 'asset-inventory' : 'knowledge-ingestion'
    const rawValue = input.input_asset_id === undefined ? (typeof input.input_value === 'string' ? input.input_value.trim() : source.source_reference) : source.source_reference
    const projectName = this.database.getProjectContext(projectId)?.name
    return this.tasks.create({ templateId, title: sourceTitle(source, input.title), inputType: source.source_type, inputValue: rawValue, workspacePath, ...(projectName === undefined ? {} : { projectName }), ...(input.input_asset_id === undefined ? {} : { inputAssetId: input.input_asset_id }) })
  }

  private pipelineFor(source: DetectedKnowledgeSource): KnowledgeIngestionPipeline {
    if (source.source_type === 'video_url') return 'video_knowledge'
    if (source.source_type === 'local_file' && mediaInputTypeForFile(source.source_reference) !== null) return 'video_knowledge'
    if (source.source_type === 'local_file' && documentSubtypeForFile(source.source_reference) !== null) return 'document_knowledge'
    if (source.source_type === 'local_file') return 'file_analysis'
    if (source.source_type === 'local_folder') return 'folder_inventory'
    if (source.source_type === 'github_repo' && source.metadata.github_kind === 'repository') return 'github_knowledge'
    if (source.source_type === 'web_url' || source.source_type === 'github_repo') return 'web_knowledge'
    return 'source_registration'
  }

  private pipelineLabel(pipeline: KnowledgeIngestionPipeline): string {
    const labels: Record<KnowledgeIngestionPipeline, string> = { video_knowledge: '视频知识处理链路', file_analysis: '文件分析', folder_inventory: '文件夹统计', web_knowledge: '网页知识处理', github_knowledge: 'GitHub 项目分析', document_knowledge: '本机文档处理', source_registration: '来源登记' }
    return labels[pipeline]
  }

  private completedMessage(document: UnifiedDocumentRecord): string {
    if (document.source_type === 'github_repo') return `已读取公开 GitHub 项目 ${document.title}，整理了 ${document.sections.length} 个内容段。${document.metadata.partial === true ? '仓库较大，已进行受控的部分分析。' : ''}`
    if (document.source_type === 'local_file') return `已提取本机文档，共 ${document.sections.length} 个章节；学习资料和 Word 文档会保存在当前任务产物中。`
    return `已提取公开网页正文，共 ${document.sections.length} 个章节；学习资料和 Word 文档会保存在当前任务产物中。`
  }
}
