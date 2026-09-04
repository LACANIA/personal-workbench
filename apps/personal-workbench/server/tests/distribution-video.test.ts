import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { EvidenceAuditService } from '../src/artifacts/evidence-audit-service.ts'
import { ReleaseAuditService } from '../src/artifacts/release-audit-service.ts'
import { ReviewPolicyService } from '../src/artifacts/review-policy-service.ts'
import { ReviewQueueService } from '../src/artifacts/review-queue-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { PATHS } from '../src/config.ts'
import { detectLocalConfig, validateLocalConfig } from '../src/portable-config.ts'
import { TaskManager } from '../src/tasks/manager.ts'
import { cosineSimilarity, localHashEmbedding } from '../src/video/embedding.ts'
import { MediaToolService } from '../src/video/media-tools.ts'
import { VideoKnowledgeRepository } from '../src/video/repository.ts'
import { VideoKnowledgeService } from '../src/video/service.ts'
import { parseSubtitle, renderTranscript, segmentSubtitle } from '../src/video/subtitle.ts'

const SRT = `1
00:00:00,000 --> 00:00:04,000
Project Context connects tasks and files.

2
00:00:04,000 --> 00:00:09,000
Evidence review is required before publication.

3
00:00:09,000 --> 00:00:15,000
研究记忆需要来源、审核与明确的项目关联。
`

describe('STEP-26 subtitle and local embedding', () => {
  it('parses SRT timestamps', () => {
    const parsed = parseSubtitle(SRT, '.srt', 'zh')
    expect(parsed.cues).toHaveLength(3)
    expect(parsed.durationMs).toBe(15_000)
  })

  it('parses WebVTT timestamps', () => {
    const parsed = parseSubtitle('WEBVTT\n\n00:00.000 --> 00:02.000\nhello\n', '.vtt')
    expect(parsed.cues[0]).toMatchObject({ startMs: 0, endMs: 2000, text: 'hello' })
  })

  it('creates timed plain text cues', () => {
    const parsed = parseSubtitle('第一段\n\n第二段', '.txt')
    expect(parsed.cues.map(item => item.startMs)).toEqual([0, 8000])
  })

  it('rejects unsupported subtitle formats', () => expect(() => parseSubtitle('x', '.ass')).toThrow('UNSUPPORTED_SUBTITLE_EXTENSION'))

  it('segments deterministically', () => {
    const parsed = parseSubtitle(SRT, '.srt')
    expect(segmentSubtitle(parsed, { maxChars: 100, maxDurationMs: 10_000 })).toEqual(segmentSubtitle(parsed, { maxChars: 100, maxDurationMs: 10_000 }))
  })

  it('generates a timestamped Markdown transcript', () => {
    const text = renderTranscript('Demo', segmentSubtitle(parseSubtitle(SRT, '.srt')))
    expect(text).toContain('# Demo')
    expect(text).toContain('## 0.000s')
  })

  it('generates deterministic normalized vectors', () => {
    const first = localHashEmbedding('Research Memory')
    const second = localHashEmbedding('Research Memory')
    expect(first).toEqual(second)
    expect(first).toHaveLength(256)
    expect(cosineSimilarity(first, second)).toBeCloseTo(1, 6)
  })

  it('does not create an all-zero vector for Chinese text', () => expect(localHashEmbedding('视频知识').some(value => value !== 0)).toBe(true))
})

describe('STEP-26 portable config', () => {
  it('detects paths from the application location rather than a username literal', () => {
    const appRoot = path.join('E:\\PortableLab', 'my-agent', 'apps', 'personal-workbench')
    const config = detectLocalConfig(appRoot, { PATH: '', LOCALAPPDATA: 'C:\\Users\\Portable\\AppData\\Local' })
    expect(config.workspace_root).toBe(path.resolve('E:\\PortableLab'))
    expect(config.project_path).toBe(path.resolve('E:\\PortableLab\\my-agent'))
  })

  it('accepts an explicit executable path in portable config', () => {
    const detected = detectLocalConfig(path.join('E:\\PortableLab', 'my-agent', 'apps', 'personal-workbench'), { PATH: '' })
    const validated = validateLocalConfig({ ...detected, ollama_executable: 'D:\\Apps\\Ollama\\ollama.exe' })
    expect(validated.ollama_executable).toBe(path.resolve('D:\\Apps\\Ollama\\ollama.exe'))
  })

  it('rejects a remote Ollama endpoint', () => {
    const detected = detectLocalConfig(path.join('E:\\PortableLab', 'my-agent', 'apps', 'personal-workbench'), { PATH: '' })
    expect(() => validateLocalConfig({ ...detected, ollama_endpoint: 'https://example.com' })).toThrow('LOCAL_CONFIG_OLLAMA_ENDPOINT_NOT_LOOPBACK')
  })

  it('reports unavailable optional media adapters honestly', () => {
    const status = new MediaToolService().capabilities()
    expect(status.accepted_inputs).toEqual(['url', 'local_video', 'subtitle', 'audio'])
    expect(status.embedding.available).toBe(true)
  })
})

describe('STEP-26 Video Knowledge Agent', () => {
  let root = ''
  let database: WorkbenchDatabase
  let repository: VideoKnowledgeRepository
  let service: VideoKnowledgeService
  let review: ReviewQueueService
  let jobId = ''
  let knowledgeArtifactId = ''

  beforeAll(async () => {
    root = await mkdtemp(path.join(PATHS.appRoot, 'data', 'step26-test-'))
    const projectRoot = path.join(root, 'project')
    await import('node:fs/promises').then(module => module.mkdir(projectRoot, { recursive: true }))
    const subtitle = path.join(projectRoot, 'demo.srt')
    await writeFile(subtitle, SRT, 'utf8')
    database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
    database.createProjectContext('project-video', { name: 'Video Test', rootPath: projectRoot, description: '', projectType: 'research' })
    const evidence = new ArtifactEvidenceService(database)
    const artifacts = new ArtifactService(database, evidence)
    const audit = new EvidenceAuditService(database, artifacts, evidence)
    const policy = new ReviewPolicyService(database, artifacts, evidence, audit)
    const release = new ReleaseAuditService(artifacts, evidence, audit, policy)
    review = new ReviewQueueService(database, artifacts, evidence, audit, release, policy)
    const tasks = new TaskManager(database, artifacts)
    repository = new VideoKnowledgeRepository(database)
    service = new VideoKnowledgeService(database, repository, tasks, artifacts, evidence, release)
    const job = service.create({ project_id: 'project-video', input_type: 'subtitle', input_value: subtitle, title: 'STEP-26 Video Acceptance' })
    jobId = job.id
    const view = await service.process(job.id)
    knowledgeArtifactId = view.document!.knowledge_artifact_id!
  }, 60_000)

  afterAll(async () => {
    database.close()
    const resolved = path.resolve(root)
    if (resolved.startsWith(path.resolve(PATHS.appRoot, 'data') + path.sep)) await rm(resolved, { recursive: true, force: true })
  })

  it('creates the Workbench task and video job', () => {
    const view = service.view(jobId)
    expect(view.job.task_id).not.toBeNull()
    expect(database.getTask(view.job.task_id!)?.status).toBe('completed')
  })

  it('completes subtitle generation, segmentation and embedding', () => {
    const view = service.view(jobId)
    expect(view.job.status).toBe('awaiting_review')
    expect(view.segments.length).toBeGreaterThan(0)
    expect(view.segments[0]?.embedding_dimensions).toBe(256)
  })

  it('creates video_document, video_segment and knowledge_point records', () => {
    const view = service.view(jobId)
    expect(view.document?.memory_state).toBe('staged')
    expect(view.knowledge_points).toHaveLength(view.segments.length)
    expect(view.knowledge_points[0]?.citation).toContain('KnowledgePoint:')
  })

  it('creates Artifact records and Evidence links', () => {
    const view = service.view(jobId)
    expect(view.artifacts.length).toBeGreaterThanOrEqual(3)
    expect(database.listArtifactEvidenceLinks(knowledgeArtifactId).length).toBeGreaterThanOrEqual(2)
  })

  it('writes user-visible runtime events for the executed video stages', () => {
    const taskId = service.view(jobId).job.task_id!
    const stages = database.listEvents(taskId)
      .filter(event => event.eventType.startsWith('video.'))
      .map(event => event.eventType)
    expect(stages).toEqual(expect.arrayContaining([
      'video.created', 'video.source_detected', 'video.download', 'video.asr', 'video.segment',
      'video.knowledge_extract', 'video.artifact_generate', 'video.review',
    ]))
    expect(database.listEvents(taskId).some(event => event.eventType === 'video.runtime_stage' && (event.payload as { tool?: string }).tool === '字幕分段器')).toBe(true)
  })

  it('prevents Memory publication before human review', () => expect(() => service.publish(jobId)).toThrow('VIDEO_REVIEW_GATE_DENIED'))

  it('searches generated video segments', async () => {
    const results = await service.search('Evidence review', 'project-video')
    expect(results[0]?.text).toContain('Evidence review')
    expect(results[0]?.citation).toContain('VideoSegment:')
  })

  it('exports identifiers, timing and knowledge graph without source file bodies', async () => {
    const exported = await service.export(jobId)
    expect(exported.schema).toBe('personal-workbench.video-export.v1')
    expect(JSON.stringify(exported)).not.toContain('"embedding":[')
  })

  it('publishes only after Evidence, review signature, policy and Memory project link pass', () => {
    const reviewer = review.policy.createReviewer({ name: 'Local Knowledge Reviewer', role: 'knowledge_reviewer' })
    review.submitReview(knowledgeArtifactId, { decision: 'approved', reviewer_id: reviewer.id, policy_type: 'knowledge', note: 'STEP-26 acceptance' })
    database.upsertProjectMemoryReference({ id: 'memory-link-video', projectId: 'project-video', memoryRole: 'test', memoryProjectName: 'STAKG-SP', memoryEntityType: 'project', memoryEntityId: '1' })
    const result = service.publish(jobId)
    expect(result.release_status).toBe('READY')
    expect(result.memory_state).toBe('published')
  })

  it('keeps the database internally consistent', () => expect(repository.integrityCheck()).toEqual({ integrity: 'ok', foreignKeys: 0 }))

  it('stores generated artifacts as hashes and paths instead of file bodies', async () => {
    const view = service.view(jobId)
    const artifact = view.artifacts.find(item => item.id === knowledgeArtifactId)!
    const bytes = await readFile(artifact.absolute_path)
    expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    const artifactRow = database.db.prepare('SELECT metadata_json FROM artifacts WHERE id=?').get(artifact.id) as { metadata_json: string }
    expect(artifactRow.metadata_json).not.toContain('knowledge_points')
  })
})
