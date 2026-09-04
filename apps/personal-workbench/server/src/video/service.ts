import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ArtifactRecord,
  VideoCreateInput,
  VideoJobRecord,
  VideoJobView,
  VideoPublishResult,
  VideoSearchInput,
  VideoSearchResult,
} from '../../../shared/contracts/index.ts'
import { ArtifactEvidenceService } from '../artifacts/evidence-service.ts'
import { ReleaseAuditService } from '../artifacts/release-audit-service.ts'
import { ArtifactService } from '../artifacts/service.ts'
import { PATHS } from '../config.ts'
import { WorkbenchDatabase } from '../database.ts'
import { KnowledgeCardService } from '../knowledge/service.ts'
import { SemanticRetrievalService } from '../retrieval/service.ts'
import { assertAllowedExisting } from '../security/path-policy.ts'
import { TaskManager } from '../tasks/manager.ts'
import { MediaCleanupService } from './cleanup.ts'
import { LocalEmbeddingService } from './embedding.ts'
import { MediaToolService } from './media-tools.ts'
import { VideoKnowledgeRepository } from './repository.ts'
import { parseSubtitle, renderSrt, renderTranscript, segmentSubtitle, type KnowledgeSegment } from './subtitle.ts'
import { TranscriptCorrectionService } from './transcript-correction.ts'

function requiredText(value: unknown, field: string, maximum = 4096): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum || value.includes('\0')) {
    throw new Error(`INVALID_VIDEO_${field.toUpperCase()}`)
  }
  return value.trim()
}

function safeTitle(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 160)
}

function keywordCandidates(text: string): string[] {
  const words = text.normalize('NFKC').match(/[\p{Script=Han}]{2,12}|[A-Za-z][A-Za-z0-9._+-]{2,31}|\d+(?:\.\d+)?%?/gu) ?? []
  const counts = new Map<string, number>()
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(item => item[0])
}

function pointTitle(text: string, index: number): string {
  const firstSentence = text.replace(/\s+/gu, ' ').split(/[。！？.!?]/u)[0]?.trim() ?? ''
  return firstSentence.slice(0, 72) || `知识点 ${index + 1}`
}

function sanitizeError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.split(':', 1)[0]!.replace(/[^A-Z0-9_]/gu, '_').slice(0, 96) || 'VIDEO_PIPELINE_FAILED'
  return { code, message: message.slice(0, 1000) }
}

export class VideoKnowledgeService {
  private readonly running = new Set<string>()
  readonly knowledge: KnowledgeCardService
  readonly correction = new TranscriptCorrectionService()

  constructor(
    readonly database: WorkbenchDatabase,
    readonly repository: VideoKnowledgeRepository,
    readonly tasks: TaskManager,
    readonly artifacts: ArtifactService,
    readonly evidence: ArtifactEvidenceService,
    readonly release: ReleaseAuditService,
    readonly media = new MediaToolService(),
    readonly embeddings = new LocalEmbeddingService(PATHS.ollamaEndpoint, PATHS.modelName),
    readonly cleanup = new MediaCleanupService(),
    readonly retrieval = new SemanticRetrievalService(database),
  ) {
    this.knowledge = new KnowledgeCardService(database, repository, artifacts, evidence, retrieval)
  }

  create(input: VideoCreateInput): VideoJobRecord {
    if (input === null || typeof input !== 'object') throw new Error('INVALID_VIDEO_INPUT')
    const project = input.project_id === undefined
      ? this.database.getPersonalInboxProject()
      : this.database.getProjectContext(requiredText(input.project_id, 'project_id', 128))
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    if (!['url', 'local_video', 'subtitle', 'audio'].includes(input.input_type)) throw new Error('INVALID_VIDEO_INPUT_TYPE')
    const selected = input.input_asset_id === undefined ? null : this.tasks.inputs.get(input.input_asset_id)
    if (selected !== null && selected.asset.input_type !== 'file') throw new Error('INPUT_TYPE_MISMATCH')
    const selectedPath = selected?.effective_path
    const value = this.media.sanitizedInput(input.input_type, selectedPath ?? requiredText(input.input_value, 'input_value'))
    const title = safeTitle(input.title ?? `视频知识 · ${path.basename(value) || value}`)
    const task = this.tasks.create({
      templateId: 'video-to-knowledge', title, inputType: input.input_type, inputValue: value,
      workspacePath: project.rootPath, projectName: project.name, databaseRole: 'production',
      ...(input.input_asset_id === undefined ? {} : { inputAssetId: input.input_asset_id }),
    })
    const job = this.repository.createJob({
      projectId: project.id, taskId: task.id, inputType: input.input_type, inputValue: value, title,
      language: typeof input.language === 'string' && input.language.trim().length > 0 ? input.language.trim().slice(0, 32) : 'auto',
    })
    const created = this.repository.updateJob(job.id, { metadata: { ...job.metadata, ...(input.input_asset_id === undefined ? {} : { input_asset_id: input.input_asset_id }) } })
    this.tasks.recordEvent(task.id, 'video.created', 'workbench', { jobId: created.id, stage: 'created', progress: 0 })
    return created
  }

  start(jobId: string): VideoJobRecord {
    const job = this.requiredJob(jobId)
    if (!['created', 'failed'].includes(job.status)) throw new Error(`VIDEO_JOB_STATE_CONFLICT: ${job.status}`)
    if (this.running.has(job.id)) throw new Error('VIDEO_JOB_ALREADY_RUNNING')
    const started = this.repository.updateJob(job.id, {
      status: 'inspecting', stage: 'inspecting', progress: 5, errorCode: null, errorMessage: null,
      metadata: { ...job.metadata, process_logs: [] },
    })
    if (started.task_id !== null) {
      this.tasks.startExternal(started.task_id, {
        stage: 'initializing', progress: 5, message: '正在检查视频输入和本机媒体组件。', activeModel: null,
      })
      this.tasks.recordEvent(started.task_id, 'video.runtime_stage', 'workbench', {
        jobId: started.id, stage: 'created', canonical_stage: 'created', progress: 0, tool: '任务调度器', message: '视频任务已经创建。',
      })
    }
    this.update(started.id, started.task_id, 'inspecting', 6)
    this.recordLog(started.id, { timestamp: new Date().toISOString(), stage: 'inspecting', level: 'info', message: '开始检查媒体输入。' })
    this.running.add(job.id)
    void this.process(job.id).catch(() => undefined).finally(() => this.running.delete(job.id))
    return started
  }

  async process(jobId: string): Promise<VideoJobView> {
    const job = this.requiredJob(jobId)
    const project = this.database.getProjectContext(job.project_id)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const taskId = job.task_id
    if (taskId !== null) {
      this.tasks.startExternal(taskId, { stage: 'initializing', progress: 7, message: '视频知识流水线已经启动。', activeModel: null })
      this.tasks.recordEvent(taskId, 'video.pipeline.started', 'workbench', { jobId: job.id, inputType: job.input_type })
    }
    try {
      const projectRoot = await assertAllowedExisting(project.rootPath, 'directory')
      const outputDirectory = path.join(projectRoot, 'output', 'video-knowledge', job.id)
      await mkdir(outputDirectory, { recursive: true })
      await assertAllowedExisting(outputDirectory, 'directory')
      this.update(job.id, taskId, 'adapting', 10)
      this.update(job.id, taskId, 'acquiring', 15)
      const inputAssetId = typeof job.metadata.input_asset_id === 'string' ? job.metadata.input_asset_id : null
      const authorizedPath = inputAssetId === null || job.input_type === 'url'
        ? undefined
        : await this.tasks.inputs.assertTaskAccess(taskId!, inputAssetId, job.input_value, 'file')
      const acquired = await this.media.acquire(job.input_type, job.input_value, outputDirectory, {
        ...(authorizedPath === undefined ? {} : { authorizedPath }),
        language: job.language,
        onLog: entry => {
          this.recordLog(job.id, entry)
          const progress: Record<string, number> = { inspecting: 8, acquiring: 18, probing: 27, audio_extract: 33, transcribing: 38 }
          if (entry.stage in progress) this.update(job.id, taskId, entry.stage, progress[entry.stage]!)
        },
      })
      const copiedSubtitle = await this.media.copySubtitleForAudit(acquired.subtitlePath, outputDirectory)
      const rawSubtitle = await this.media.readSubtitle(copiedSubtitle)
      const parsed = parseSubtitle(rawSubtitle, path.extname(copiedSubtitle), job.language)
      this.update(job.id, taskId, 'frame_extract', 41)
      const ocrExecution = await this.media.ocr.extract(acquired.sourcePath, outputDirectory, acquired.mediaProbe, entry => {
        this.recordLog(job.id, entry)
        const progress: Record<string, number> = { frame_extract: 43, ocr: 48 }
        if (entry.stage in progress) this.update(job.id, taskId, entry.stage, progress[entry.stage]!)
      })
      if (ocrExecution.status === 'unavailable' && acquired.mediaProbe?.video_codec !== null) throw new Error('OCR_RUNTIME_MISSING')
      this.update(job.id, taskId, 'fusion', 51)
      this.recordLog(job.id, { timestamp: new Date().toISOString(), stage: 'fusion', level: 'info', message: '正在融合 ASR 转录与关键帧 OCR 文字。' })
      const correction = await this.correction.correct(parsed, ocrExecution.frames)
      this.update(job.id, taskId, 'term_correction', 55)
      this.recordLog(job.id, {
        timestamp: new Date().toISOString(), stage: 'term_correction', level: 'info',
        message: `正在校准专业术语；已应用 ${correction.changes.length} 处受控词典修正。`,
      })
      const correctedSubtitlePath = path.join(outputDirectory, 'corrected-transcript.srt')
      await writeFile(correctedSubtitlePath, renderSrt(correction.parsed), { encoding: 'utf8', flag: 'wx' })
      const afterAcquire = this.repository.getJob(job.id)!
      this.repository.updateJob(job.id, {
        sourcePath: acquired.sourcePath, subtitlePath: correctedSubtitlePath,
        metadata: {
          ...afterAcquire.metadata,
          transcript_source: acquired.transcriptSource,
          raw_subtitle_path: copiedSubtitle,
          corrected_subtitle_path: correctedSubtitlePath,
          media_probe: acquired.mediaProbe,
          url_metadata: acquired.urlMetadata,
          asr_execution: acquired.asr,
          ocr_execution: ocrExecution,
          correction: {
            transcript_source: correction.transcript_source,
            dictionary_version: correction.dictionary_version,
            change_count: correction.changes.length,
            changes: correction.changes,
            original_sha256: correction.original_sha256,
            corrected_sha256: correction.corrected_sha256,
          },
        },
      })

      this.update(job.id, taskId, 'segmenting', 58)
      // 从这里开始，所有 Segment、Legacy Knowledge Point 与 Knowledge Card 都只读校正后的转录。
      const segments = segmentSubtitle(correction.parsed)
      this.recordLog(job.id, { timestamp: new Date().toISOString(), stage: 'segmenting', level: 'info', message: `生成 ${segments.length} 个时间轴分段。` })

      this.update(job.id, taskId, 'embedding', 64)
      const vectors = [] as Awaited<ReturnType<LocalEmbeddingService['embed']>>[]
      for (const segment of segments) vectors.push(await this.embeddings.embed(segment.text))

      this.update(job.id, taskId, 'analyzing', 70)

      const document = this.repository.createDocument({
        projectId: project.id, jobId: job.id, title: job.title, sourceKind: job.input_type,
        sourceReference: acquired.sourceReference, language: correction.parsed.language, durationMs: correction.parsed.durationMs,
        segmentCount: segments.length, knowledgePointCount: segments.length,
        metadata: {
          subtitle_format: correction.parsed.format,
          transcript_source: acquired.transcriptSource,
          media_probe: acquired.mediaProbe,
          asr_execution: acquired.asr,
          ocr_execution: ocrExecution,
          correction: {
            transcript_source: correction.transcript_source,
            dictionary_version: correction.dictionary_version,
            change_count: correction.changes.length,
            original_sha256: correction.original_sha256,
            corrected_sha256: correction.corrected_sha256,
          },
          created_by: 'personal-workbench-video-v2',
        },
      })
      const segmentRows = this.repository.insertSegments(document.id, segments.map((segment, index) => ({
        index: segment.index, startMs: segment.startMs, endMs: segment.endMs, text: segment.text, textHash: segment.textHash,
        embeddingProvider: vectors[index]!.provider, embeddingModel: vectors[index]!.model, embedding: vectors[index]!.vector,
      })))
      const points = this.repository.insertKnowledgePoints(document.id, segmentRows.map((segment, index) => ({
        segmentId: segment.id, title: pointTitle(segment.text, index), summary: segment.text.replace(/\s+/gu, ' ').slice(0, 600),
        keywords: keywordCandidates(segment.text), confidence: 1,
      })))
      const embeddingIndex = await this.retrieval.indexDocument(document.id)
      const edges = this.repository.insertEdges(document.id, points)

      const transcriptPath = path.join(outputDirectory, 'transcript.md')
      const knowledgePath = path.join(outputDirectory, 'knowledge.json')
      const graphPath = path.join(outputDirectory, 'knowledge-graph.json')
      await writeFile(transcriptPath, renderTranscript(job.title, segments), { encoding: 'utf8', flag: 'wx' })

      const sourceArtifact = await this.registerArtifact(project.id, taskId, copiedSubtitle, 'document', '视频字幕来源')
      const transcriptArtifact = await this.registerArtifact(project.id, taskId, transcriptPath, 'document', '带时间戳转录文本')
      this.linkArtifact(transcriptArtifact, sourceArtifact)
      let ocrArtifact: ArtifactRecord | null = null
      if (ocrExecution.output_path !== null) {
        ocrArtifact = await this.registerArtifact(project.id, taskId, ocrExecution.output_path, 'analysis', '视频关键帧 OCR 结果')
        this.linkArtifact(transcriptArtifact, ocrArtifact)
      }
      this.repository.attachArtifacts(document.id, { source: sourceArtifact.id, transcript: transcriptArtifact.id })

      this.update(job.id, taskId, 'analyzing', 75)
      this.recordLog(job.id, { timestamp: new Date().toISOString(), stage: 'analyzing', level: 'info', message: '正在基于已校正的转录文本生成结构化 Knowledge Card。' })
      const knowledgeCards = await this.knowledge.extractDocument(document.id)

      this.update(job.id, taskId, 'packaging', 86)
      await writeFile(knowledgePath, `${JSON.stringify({
        schema: 'personal-workbench.video-knowledge.v2', document_id: document.id, title: document.title,
        source_reference: document.source_reference, language: document.language,
        transcript: { raw_subtitle: copiedSubtitle, corrected_subtitle: correctedSubtitlePath, correction },
        ocr: { status: ocrExecution.status, engine: ocrExecution.engine, frame_count: ocrExecution.frame_count, text_frame_count: ocrExecution.text_frame_count },
        segments: segmentRows.map(segment => ({ id: segment.id, index: segment.segment_index, start_ms: segment.start_ms, end_ms: segment.end_ms, text_hash: segment.text_hash, citation: segment.citation })),
        knowledge_points: points, knowledge_card_batch: { id: knowledgeCards.batch.id, artifact_id: knowledgeCards.artifact.id, card_count: knowledgeCards.cards.length },
        embedding: { provider: vectors[0]?.provider ?? 'local-hash-v1', model: vectors[0]?.model ?? 'unicode-ngram-sha256' },
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await writeFile(graphPath, `${JSON.stringify({ document_id: document.id, nodes: points, edges }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      const knowledgeArtifact = await this.registerArtifact(project.id, taskId, knowledgePath, 'other', '视频知识包')
      const graphArtifact = await this.registerArtifact(project.id, taskId, graphPath, 'other', '视频知识关系图')
      this.linkArtifact(knowledgeArtifact, transcriptArtifact)
      this.linkArtifact(graphArtifact, knowledgeArtifact)
      this.repository.attachArtifacts(document.id, { knowledge: knowledgeArtifact.id })
      if (job.input_type === 'url' && acquired.sourcePath === null) throw new Error('VIDEO_DOWNLOAD_MISSING')
      const cleanupResult = job.input_type === 'url'
        ? await this.cleanup.cleanupCompletedUrlDownload(outputDirectory, acquired.sourcePath!)
        : { removed: [] as string[], retained: [] as string[] }
      if (cleanupResult.removed.length > 0) {
        this.recordLog(job.id, { timestamp: new Date().toISOString(), stage: 'packaging', level: 'info', message: `已清理 ${cleanupResult.removed.length} 个下载或转写临时媒体文件。` })
      }
      const completed = this.repository.updateJob(job.id, {
        status: 'awaiting_review', stage: 'awaiting_review', progress: 100, documentId: document.id, completed: true,
        sourcePath: job.input_type === 'url' && cleanupResult.removed.length > 0 ? null : acquired.sourcePath,
        metadata: {
          ...this.repository.getJob(job.id)!.metadata,
          embedding_provider: vectors[0]?.provider ?? 'local-hash-v1',
          embedding_mode_label: (vectors[0]?.provider ?? 'local-hash-v1') === 'local-hash-v1' ? '基础本地检索模式' : '本机 Embedding',
          embedding_index: embeddingIndex,
          graph_artifact_id: graphArtifact.id,
          output_directory: outputDirectory,
          transcript_source: acquired.transcriptSource,
          ocr_execution: ocrExecution,
          correction: {
            transcript_source: correction.transcript_source,
            dictionary_version: correction.dictionary_version,
            change_count: correction.changes.length,
            original_sha256: correction.original_sha256,
            corrected_sha256: correction.corrected_sha256,
          },
          knowledge_card_batch_id: knowledgeCards.batch.id,
          knowledge_card_count: knowledgeCards.cards.length,
          downloaded_media_retained: job.input_type === 'url' ? cleanupResult.removed.length === 0 : null,
        },
      })
      if (taskId !== null) {
        const resultText = `视频知识候选已经生成：${segments.length} 个分段、${points.length} 个 Legacy 知识点和 ${knowledgeCards.cards.length} 张结构化 Knowledge Card。长期发布需要通过 Evidence、Knowledge Policy 与人工审核。`
        const currentTask = this.database.getTask(taskId)
        this.update(job.id, taskId, 'awaiting_review', 100)
        this.tasks.runtimeLog(taskId, { stage: 'review', level: 'info', message: 'Video Knowledge 已进入人工审核队列。' })
        this.tasks.completeExternal(taskId, { resultText, metadata: { ...currentTask?.metadata, execution: 'video-local-v1', jobId: job.id, documentId: document.id, knowledgeArtifactId: knowledgeArtifact.id } })
        this.tasks.recordEvent(taskId, 'video.pipeline.completed', 'workbench', { jobId: job.id, documentId: document.id, knowledgeArtifactId: knowledgeArtifact.id, status: completed.status })
      }
      return this.repository.view(job.id)
    } catch (error) {
      const failure = sanitizeError(error)
      this.recordLog(job.id, { timestamp: new Date().toISOString(), stage: 'failed', level: 'error', message: `媒体任务失败：${failure.code}` })
      this.repository.updateJob(job.id, { status: 'failed', stage: 'failed', errorCode: failure.code, errorMessage: failure.message, completed: true })
      if (taskId !== null) {
        this.tasks.failExternal(taskId, { errorCode: failure.code, errorMessage: failure.message })
        this.tasks.recordEvent(taskId, 'video.pipeline.failed', 'workbench', { jobId: job.id, errorCode: failure.code })
      }
      throw error
    } finally {
      if (taskId !== null) await this.tasks.releaseExternalInput(taskId)
    }
  }

  view(jobId: string): VideoJobView { return this.repository.view(jobId) }
  list(projectId?: string): VideoJobRecord[] { return this.repository.listJobs(projectId) }

  async search(queryOrInput: string | VideoSearchInput, projectId?: string, limit = 8): Promise<VideoSearchResult[]> {
    const input: VideoSearchInput = typeof queryOrInput === 'string'
      ? { query: queryOrInput, ...(projectId === undefined ? {} : { project_id: projectId }), top_k: limit, provider: 'local-hash-v1', entity_type: 'video_segment' }
      : queryOrInput
    return this.retrieval.search(input)
  }

  publish(jobId: string): VideoPublishResult {
    const view = this.repository.view(jobId)
    if (view.document === null || view.document.knowledge_artifact_id === null) throw new Error('VIDEO_KNOWLEDGE_ARTIFACT_NOT_FOUND')
    const release = this.release.inspectArtifact(view.document.knowledge_artifact_id)
    if (release.status !== 'READY') throw new Error(`VIDEO_REVIEW_GATE_DENIED: ${release.status}`)
    const references = this.database.listProjectMemoryReferences(view.document.project_id)
    const memoryProject = references.find(reference => reference.memoryEntityType === 'project')
    if (memoryProject === undefined) throw new Error('VIDEO_MEMORY_PROJECT_LINK_REQUIRED')
    const published = this.repository.publish(view.document.id, {
      artifactId: view.document.knowledge_artifact_id,
      memoryRole: memoryProject.memoryRole,
      memoryProjectName: memoryProject.memoryProjectName,
      releaseStatus: release.status,
    })
    this.retrieval.markDocumentApproved(view.document.id)
    this.repository.updateJob(jobId, { status: 'published', stage: 'published', progress: 100, completed: true })
    return {
      video_document: published, artifact_id: view.document.knowledge_artifact_id, release_status: release.status,
      memory_state: published.memory_state, published_knowledge_points: view.knowledge_points.length, published_segments: view.segments.length,
    }
  }

  async export(jobId: string): Promise<Record<string, unknown>> {
    const view = this.repository.view(jobId)
    return {
      schema: 'personal-workbench.video-export.v1', exported_at: new Date().toISOString(),
      video_document: view.document, segments: view.segments.map(segment => ({ ...segment, embedding: undefined })),
      knowledge_points: view.knowledge_points, edges: view.edges, chapters: view.chapters,
    }
  }

  private requiredJob(jobId: string): VideoJobRecord {
    const job = this.repository.getJob(requiredText(jobId, 'job_id', 128))
    if (job === undefined) throw new Error('VIDEO_JOB_NOT_FOUND')
    return job
  }

  private update(jobId: string, taskId: string | null, stage: string, progress: number): void {
    const statusMap: Record<string, VideoJobRecord['status']> = {
      created: 'created', inspecting: 'inspecting', adapting: 'inspecting', acquiring: 'acquiring', probing: 'inspecting', audio_extract: 'transcribing', transcribing: 'transcribing',
      frame_extract: 'transcribing', ocr: 'transcribing', fusion: 'transcribing', term_correction: 'transcribing',
      segmenting: 'segmenting', embedding: 'embedding', analyzing: 'embedding', packaging: 'packaging', awaiting_review: 'awaiting_review',
    }
    this.repository.updateJob(jobId, { status: statusMap[stage] ?? 'inspecting', stage, progress })
    if (taskId !== null) {
      const runtime: Record<string, { stage: import('../../../shared/contracts/index.ts').TaskRuntimeStage; model: string | null; message: string; canonicalStage: string; tool: string }> = {
        inspecting: { stage: 'initializing', model: null, message: '正在检查媒体输入。', canonicalStage: 'source_detected', tool: '输入适配器' },
        adapting: { stage: 'adapting', model: null, message: '正在确认输入授权与受控输出目录。', canonicalStage: 'source_detected', tool: '输入授权' },
        acquiring: { stage: 'fetching', model: 'yt-dlp / 本地媒体', message: '正在准备媒体或字幕来源。', canonicalStage: 'download', tool: 'yt-dlp / 本地媒体' },
        probing: { stage: 'processing', model: 'ffprobe', message: '正在读取媒体编码与音轨信息。', canonicalStage: 'media_probe', tool: 'ffprobe' },
        audio_extract: { stage: 'processing', model: 'ffmpeg', message: '正在提取并规范化音轨。', canonicalStage: 'audio_extract', tool: 'ffmpeg' },
        transcribing: { stage: 'transcribing', model: 'faster-whisper-small', message: '正在生成带时间戳的转录文本。', canonicalStage: 'asr', tool: 'faster-whisper-small' },
        frame_extract: { stage: 'processing', model: 'ffmpeg', message: '正在抽取视频关键帧。', canonicalStage: 'frame_extract', tool: 'ffmpeg' },
        ocr: { stage: 'extracting', model: 'RapidOCR', message: '正在 OCR 识别字幕、演示页、公式与代码画面。', canonicalStage: 'ocr', tool: 'rapidocr_onnxruntime' },
        fusion: { stage: 'extracting', model: null, message: '正在融合 ASR 与 OCR 文本。', canonicalStage: 'asr_ocr_fusion', tool: '文本融合器' },
        term_correction: { stage: 'extracting', model: null, message: '正在校准通信、数学、计算机与物理术语。', canonicalStage: 'term_correction', tool: '领域词典' },
        segmenting: { stage: 'segmenting', model: null, message: '正在生成时间轴分段。', canonicalStage: 'segment', tool: '字幕分段器' },
        embedding: { stage: 'embedding', model: 'qwen3-embedding:0.6b', message: '正在构建本地检索索引。', canonicalStage: 'knowledge_extract', tool: 'qwen3-embedding:0.6b' },
        analyzing: { stage: 'extracting', model: null, message: '正在整理知识候选。', canonicalStage: 'knowledge_extract', tool: '知识处理器' },
        packaging: { stage: 'generating', model: null, message: '正在生成 Artifact 与 Evidence。', canonicalStage: 'artifact_generate', tool: '产物生成器' },
        awaiting_review: { stage: 'review', model: null, message: '正在等待人工审核。', canonicalStage: 'review', tool: '审核队列' },
      }
      const mapped = runtime[stage] ?? { stage: 'processing' as const, model: null, message: '视频任务正在处理。', canonicalStage: 'processing', tool: '视频流水线' }
      this.tasks.updateRuntime(taskId, { current_stage: mapped.stage, progress, status: 'running', message: mapped.message, active_model: mapped.model })
      this.tasks.recordEvent(taskId, `video.${stage}`, 'workbench', { jobId, stage, progress })
      this.tasks.recordEvent(taskId, 'video.runtime_stage', 'workbench', {
        jobId, stage, canonical_stage: mapped.canonicalStage, progress, tool: mapped.tool, message: mapped.message,
      })
      this.tasks.recordEvent(taskId, `video.${mapped.canonicalStage}`, 'workbench', {
        jobId, stage, progress, tool: mapped.tool, message: mapped.message,
      })
    }
  }

  private recordLog(jobId: string, entry: { timestamp: string; stage: string; level: 'info' | 'warning' | 'error'; message: string; duration_ms?: number }): void {
    const current = this.repository.getJob(jobId)
    if (current === undefined) return
    const existing = Array.isArray(current.metadata.process_logs) ? current.metadata.process_logs : []
    this.repository.updateJob(jobId, { metadata: { ...current.metadata, process_logs: [...existing, entry].slice(-200) } })
    if (current.task_id !== null) {
      const stage: Record<string, import('../../../shared/contracts/index.ts').TaskRuntimeStage> = {
        inspecting: 'initializing', adapting: 'adapting', acquiring: 'fetching', probing: 'processing', audio_extract: 'processing', transcribing: 'transcribing', segmenting: 'segmenting',
        frame_extract: 'processing', ocr: 'extracting', fusion: 'extracting', term_correction: 'extracting',
        embedding: 'embedding', analyzing: 'extracting', packaging: 'generating', awaiting_review: 'review', failed: 'failed',
      }
      this.tasks.runtimeLog(current.task_id, { timestamp: entry.timestamp, stage: stage[entry.stage] ?? 'processing', level: entry.level, message: entry.message })
    }
  }

  private async registerArtifact(projectId: string, taskId: string | null, filePath: string, type: ArtifactRecord['artifact_type'], role: string): Promise<ArtifactRecord> {
    const job = this.repository.listJobs(projectId, 1)[0]
    const artifact = await this.artifacts.register({ project_id: projectId, ...(taskId === null ? {} : { task_id: taskId }), file_path: filePath,
      artifact_type: type, metadata: { video_role: role, generated_by: 'video-local-v2', transcript_source: job?.metadata.transcript_source ?? null } })
    return artifact
  }

  private linkArtifact(target: ArtifactRecord, source: ArtifactRecord): void {
    try { this.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'derived_from' }) } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('UNIQUE')) throw error
    }
  }
}
