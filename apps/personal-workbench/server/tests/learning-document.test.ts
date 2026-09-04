import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import {
  LearningDocumentService,
  Qwen3LearningDocumentProvider,
  extractOcrFormulaEvidence,
  learningDocumentGenerationTimeoutMs,
  type GeneratedLearningContent,
  type LearningDocumentProvider,
  safeLearningFilename,
  validateLearningDocumentPayload,
} from '../src/learning/service.ts'
import { readDocxDocumentXml } from '../src/reports/docx.ts'
import { TaskManager } from '../src/tasks/manager.ts'
import { localHashEmbedding } from '../src/video/embedding.ts'
import { VideoKnowledgeRepository } from '../src/video/repository.ts'

const roots: string[] = []

class FixtureProvider implements LearningDocumentProvider {
  fail = false
  unsafeMath = false
  metadata() { return { provider: 'qwen3_local' as const, model: 'qwen3:8b', prompt_version: 'learning-document-v1', prompt_sha256: 'a'.repeat(64), endpoint: 'http://127.0.0.1:11434' } }
  async generate(): Promise<GeneratedLearningContent> {
    if (this.fail) throw new Error('LEARNING_DOCUMENT_HTTP_503')
    const document: GeneratedLearningContent = {
      document_title: 'IQ信号学习笔记', summary: '资料说明 I 路与 Q 路如何通过正交分量表达相位信息。',
      learning_goals: ['理解 IQ信号 的基本组成。', '说明 I 路与 Q 路的正交关系。', '识别余弦函数与相位在表达式中的作用。'],
      sections: [{ title: 'IQ信号与正交分量', summary: 'I 路和 Q 路构成正交分量。', body: 'IQ信号使用余弦函数 cos(2πft + φ) 表达相位相关信息。', key_points: ['I 路和 Q 路彼此正交。', 'cos 与相位都来自已校正转录。'], examples: ['A cos(2πft + φ)'], source_refs: ['00:00:00 - 00:00:10'] }],
      terms: [{ term: 'IQ信号', explanation: '由 I 路和 Q 路组成的表示方式。' }, { term: '相位', explanation: '资料中由 φ 表示。' }],
      confusions: ['相位不能误写为向位。'], key_points: ['余弦函数的术语已经校正。', 'cos 保持为来源中的写法。', '来源具有可回看的时间范围。'],
      review_questions: ['I 路和 Q 路之间是什么关系？', 'cos 在来源中如何出现？', 'φ 表示什么？', '为什么要保留时间引用？', '如何回看原始视频？'],
      learning_tips: ['先对照时间引用回看相关片段。'],
    }
    if (this.unsafeMath) {
      document.sections[0] = {
        ...document.sections[0]!,
        body: 'A cos(2πft + φ) 可以写成 I 路的 A cos(2πft) 与 Q 路的 A sin(2πft)。',
        examples: ['A cos(2πft + φ) = A cos(2πft) - A sin(2πft)', 'IQ坐标点(3,4)的相位是 arctan(4/3)'],
      }
    }
    return document
  }
}

async function fixture(video = true): Promise<{ root: string; database: WorkbenchDatabase; artifacts: ArtifactService; tasks: TaskManager; video: VideoKnowledgeRepository; service: LearningDocumentService; provider: FixtureProvider; taskId: string; transcriptArtifactId: string | null }> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', `step33-${randomUUID()}`)
  await mkdir(path.join(root, 'output'), { recursive: true })
  roots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  database.createProjectContext('learning-project', { name: 'Learning Fixture', rootPath: root, description: '', projectType: 'general' })
  const artifacts = new ArtifactService(database, new ArtifactEvidenceService(database))
  const tasks = new TaskManager(database, artifacts)
  const repo = new VideoKnowledgeRepository(database)
  const provider = new FixtureProvider()
  const taskId = randomUUID()
  const sourcePath = path.join(root, video ? 'fixture.srt' : 'source.md')
  await writeFile(sourcePath, video ? '1\n00:00:00,000 --> 00:00:10,000\nIQ信号\n' : '# 本地资料\n\n变量可以通过公式表达。\n\ny = 2x + 1\n\n```ts\nconst y = 2 * x + 1\n```\n', 'utf8')
  database.createTask(taskId, { templateId: video ? 'video-to-knowledge' : 'file-analysis', inputType: video ? 'subtitle' : 'file', inputValue: sourcePath, workspacePath: root, projectName: 'Learning Fixture', title: video ? 'IQ信号视频' : '本地文本资料' })
  database.bindTaskToProject(taskId, 'learning-project', root)
  database.updateTask(taskId, { status: 'completed', startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z', resultText: '当前任务已经完成。' })
  let transcriptArtifactId: string | null = null
  if (video) {
    const job = repo.createJob({ projectId: 'learning-project', taskId, inputType: 'subtitle', inputValue: sourcePath, title: 'IQ信号课程', language: 'zh' })
    const document = repo.createDocument({ projectId: 'learning-project', jobId: job.id, title: 'IQ信号课程', sourceKind: 'subtitle', sourceReference: 'https://example.test/iq', language: 'zh', durationMs: 10_000, segmentCount: 1, knowledgePointCount: 1, metadata: { transcript_source: 'corrected_transcript' } })
    const text = 'IQ信号中的 I 路和 Q 路正交。余弦函数 cos(2πft + φ) 用于表达相位。'
    repo.insertSegments(document.id, [{ id: 'iq-segment', index: 0, startMs: 0, endMs: 10_000, text, textHash: createHash('sha256').update(text).digest('hex'), embeddingProvider: 'local-hash-v1', embeddingModel: 'unicode-ngram-sha256', embedding: localHashEmbedding(text) }])
    repo.insertKnowledgePoints(document.id, [{ segmentId: 'iq-segment', title: 'Legacy IQ', summary: text, keywords: ['IQ', '相位'], confidence: 1 }])
    const transcriptPath = path.join(root, 'output', 'corrected-transcript.md')
    await writeFile(transcriptPath, text, 'utf8')
    const artifact = await artifacts.register({ project_id: 'learning-project', task_id: taskId, file_path: transcriptPath, artifact_type: 'document', auto_link_task: true })
    transcriptArtifactId = artifact.id
    repo.attachArtifacts(document.id, { transcript: artifact.id })
    database.updateTask(taskId, { metadata: { jobId: job.id, documentId: document.id, transcript_source: 'corrected_transcript' } })
  }
  return { root, database, artifacts, tasks, video: repo, service: new LearningDocumentService(database, tasks, artifacts, repo, provider), provider, taskId, transcriptArtifactId }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('STEP-33 Learning Document', () => {
  it('validates the bounded structured document payload', () => {
    const valid = { document_title: '学习笔记', summary: '概览', learning_goals: ['一', '二', '三'], sections: [{ title: '章节', summary: '摘要', body: '正文', key_points: [], examples: [], source_refs: [] }], terms: [], confusions: [], key_points: ['一', '二', '三'], review_questions: ['一', '二', '三', '四', '五'], learning_tips: [] }
    expect(validateLearningDocumentPayload(valid)).not.toBeNull()
    expect(validateLearningDocumentPayload({ ...valid, invented: true })).toBeNull()
  })

  it('uses Ollama JSON mode after the local schema-vocabulary compatibility failure', async () => {
    const valid = {
      document_title: '学习笔记', summary: '概览', learning_goals: ['一', '二', '三'],
      sections: [{ title: '章节', summary: '摘要', body: '正文', key_points: [], examples: [], source_refs: [] }],
      terms: [], confusions: [], key_points: ['一', '二', '三'], review_questions: ['一', '二', '三', '四', '五'], learning_tips: [],
    }
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('failed to load model vocabulary required for format', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify(valid) }, done_reason: 'stop' }), { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch
    try {
      const provider = new Qwen3LearningDocumentProvider('http://127.0.0.1:11434')
      await expect(provider.generate({
        source_type: 'local_file', source_title: '资料', source_reference: '本地资料', source_text: '已有资料。',
        source_references: [], source_artifact_ids: [], timestamp_refs: [], card_summaries: [], legacy_summaries: [], formula_evidence: [],
      }, 'learning_notes', 'concise')).resolves.toEqual(expect.objectContaining({ document_title: '学习笔记' }))
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const fallback = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as { format?: unknown }
      expect(fallback.format).toBe('json')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('extends the local-model wait budget for a long standard learning source', () => {
    const source = {
      source_type: 'video', source_title: '长视频', source_reference: 'https://example.test/video',
      source_text: '已校正内容。'.repeat(2_000), source_references: [], source_artifact_ids: [], timestamp_refs: [],
      card_summaries: Array.from({ length: 50 }, (_, index) => `知识卡 ${index}：${'解释。'.repeat(20)}`), legacy_summaries: [], formula_evidence: [],
    }
    expect(learningDocumentGenerationTimeoutMs(source, 'learning_notes', 'standard')).toBeGreaterThan(180_000)
    expect(learningDocumentGenerationTimeoutMs(source, 'learning_notes', 'standard')).toBeLessThanOrEqual(600_000)
  })

  it('uses corrected video segments before raw ASR and writes a readable Word Artifact', async () => {
    const test = await fixture(true)
    const result = await test.service.generate({ task_id: test.taskId })
    const docx = test.database.getArtifact(result.docx_artifact_id!)!
    const xml = readDocxDocumentXml(await readFile(docx.absolute_path))
    expect(xml).toContain('IQ信号')
    expect(xml).toContain('余弦函数')
    expect(xml).toContain('cos')
    expect(xml).toContain('相位')
    expect(xml).not.toContain('向位')
    expect(xml).not.toContain('余显寒数')
    expect(test.database.listArtifactEvidenceLinks(docx.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: 'task', source_id: test.taskId, relation_type: 'generated_from' }),
      expect.objectContaining({ source_type: 'artifact', source_id: test.transcriptArtifactId, relation_type: 'derived_from' }),
    ]))
    expect(test.tasks.runtimeView(test.taskId).runtime.current_stage).toBe('output_ready')
    expect(test.database.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    test.database.close()
  })

  it('uses high-confidence OCR mathematical expressions as a separate, traceable learning source', async () => {
    const test = await fixture(true)
    const ocrPath = path.join(test.root, 'output', 'ocr-results.json')
    await writeFile(ocrPath, JSON.stringify({ frames: [
      { timestamp_ms: 15_000, confidence: 0.94, text: 'Acos(2πft+Φ)\n射频信号S（t）=I（t)cos（wct）-Q（t）sin（wct)' },
      { timestamp_ms: 105_000, confidence: 0.92, text: '2π△ft' },
      { timestamp_ms: 45_000, confidence: 0.72, text: 'A·cos(φ)cos(2πft)' },
    ] }), 'utf8')
    const ocrArtifact = await test.artifacts.register({ project_id: 'learning-project', task_id: test.taskId, file_path: ocrPath, artifact_type: 'analysis', metadata: { video_role: '视频关键帧 OCR 结果' }, auto_link_task: true })

    expect(extractOcrFormulaEvidence(JSON.parse(await readFile(ocrPath, 'utf8')))).toEqual([
      expect.objectContaining({ formula: 'A cos(2πft + φ)', time_range: '00:00:15', source: 'ocr' }),
      expect.objectContaining({ formula: 'S(t) = I(t) cos(wct) - Q(t) sin(wct)', time_range: '00:00:15', source: 'ocr' }),
      expect.objectContaining({ formula: '2πΔft', time_range: '00:01:45', source: 'ocr' }),
    ])

    test.provider.unsafeMath = true
    const result = await test.service.generate({ task_id: test.taskId })
    expect(result.formulas).toEqual(expect.arrayContaining([
      expect.stringContaining('A cos(2πft + φ)'),
      expect.stringContaining('S(t) = I(t) cos(wct) - Q(t) sin(wct)'),
      expect.stringContaining('2πΔft'),
    ]))
    const docx = test.database.getArtifact(result.docx_artifact_id!)!
    const xml = readDocxDocumentXml(await readFile(docx.absolute_path))
    expect(xml).toContain('Formula')
    expect(xml).toContain('A cos(2πft + φ)')
    expect(xml).not.toContain('A sin(2πft)')
    expect(xml).not.toContain('arctan(4/3)')
    expect(test.database.listArtifactEvidenceLinks(docx.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: 'artifact', source_id: ocrArtifact.id, relation_type: 'derived_from' }),
    ]))
    test.database.close()
  })

  it('creates a local text learning note with grounded formula and code', async () => {
    const test = await fixture(false)
    const result = await test.service.generate({ task_id: test.taskId, detail_level: 'detailed' })
    expect(result.formulas).toContain('y = 2x + 1')
    expect(result.code_examples[0]).toContain('const y = 2 * x + 1')
    const docx = test.database.getArtifact(result.docx_artifact_id!)!
    expect((await stat(docx.absolute_path)).size).toBeGreaterThan(300)
    test.database.close()
  })

  it('keeps earlier versions and links new Artifact versions when regenerated', async () => {
    const test = await fixture(true)
    const first = await test.service.generate({ task_id: test.taskId })
    const second = await test.service.generate({ task_id: test.taskId, supersedes_document_id: first.id, detail_level: 'concise' })
    expect(second.supersedes_document_id).toBe(first.id)
    expect(test.database.listLearningDocumentsForTask(test.taskId)).toHaveLength(2)
    expect(test.database.getArtifactLineageIds(second.docx_artifact_id!)).toContain(first.docx_artifact_id)
    test.database.close()
  })

  it('leaves the completed source task available when generation fails', async () => {
    const test = await fixture(true); test.provider.fail = true
    await expect(test.service.generate({ task_id: test.taskId })).rejects.toThrow('LEARNING_DOCUMENT_HTTP_503')
    expect(test.database.getTask(test.taskId)?.status).toBe('completed')
    expect(test.tasks.runtimeView(test.taskId).runtime.status).toBe('completed')
    test.database.close()
  })

  it('creates safe visible filenames without task identifiers', () => {
    expect(safeLearningFilename('《IQ: 信号?》学习笔记')).toBe('《IQ 信号》学习笔记')
  })
})
