import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/database.ts'
import { PATHS } from '../src/config.ts'
import { EmbeddingRecordRepository, blobToVector, vectorToBlob } from '../src/retrieval/repository.ts'
import { SemanticRetrievalService } from '../src/retrieval/service.ts'
import { LocalHashEmbeddingProvider, OllamaEmbeddingProvider, cosineSimilarity, localHashEmbedding } from '../src/video/embedding.ts'
import { VideoKnowledgeRepository } from '../src/video/repository.ts'

const roots: string[] = []
let mockServer: Server
let mockEndpoint = ''

function mockVector(text: string): number[] {
  const vector = Array.from({ length: 8 }, () => 0)
  const normalized = text.toLowerCase()
  const slot = /正交|垂直|无线/u.test(normalized) ? 0
    : /授权|相邻|路径/u.test(normalized) ? 1
      : /审核|发布/u.test(normalized) ? 2
        : createHash('sha256').update(text).digest()[0]! % 8
  vector[slot] = 1
  return vector
}

async function temporaryDatabase(): Promise<{ root: string; database: WorkbenchDatabase; video: VideoKnowledgeRepository; retrieval: SemanticRetrievalService; documentId: string; segmentId: string; pointId: string }> {
  const parent = path.join(PATHS.appRoot, 'data')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, 'step30-test-'))
  roots.push(root)
  const projectARoot = path.join(root, 'project-a')
  const projectBRoot = path.join(root, 'project-b')
  await mkdir(projectARoot, { recursive: true })
  await mkdir(projectBRoot, { recursive: true })
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  database.createProjectContext('project-a', { name: 'Project A', rootPath: projectARoot, description: '', projectType: 'research' })
  database.createProjectContext('project-b', { name: 'Project B', rootPath: projectBRoot, description: '', projectType: 'research' })
  const video = new VideoKnowledgeRepository(database)
  const job = video.createJob({ projectId: 'project-a', taskId: null, inputType: 'subtitle', inputValue: 'fixture.srt', title: 'IQ课程', language: 'zh' })
  const document = video.createDocument({
    projectId: 'project-a', jobId: job.id, title: 'IQ课程', sourceKind: 'subtitle', sourceReference: 'fixture.srt',
    language: 'zh', durationMs: 10_000, segmentCount: 1, knowledgePointCount: 1, metadata: { transcript_source: 'user_subtitle' },
  })
  const segmentText = 'I分量和Q分量相差九十度，形成复数基带的正交表示。'
  const [segment] = video.insertSegments(document.id, [{
    id: 'segment-iq', index: 0, startMs: 1_000, endMs: 9_000, text: segmentText,
    textHash: createHash('sha256').update(segmentText).digest('hex'), embeddingProvider: 'local-hash-v1',
    embeddingModel: 'unicode-ngram-sha256', embedding: localHashEmbedding(segmentText),
  }])
  const [point] = video.insertKnowledgePoints(document.id, [{
    id: 'point-iq', segmentId: segment!.id, title: '正交分量', summary: '无线信号使用互相垂直的两路分量表达幅度与相位。', keywords: ['IQ'], confidence: 1,
  }])
  const createdAt = new Date().toISOString()
  database.createArtifact({
    id: 'artifact-iq', project_id: 'project-a', task_id: null, artifact_type: 'other', name: 'knowledge.json',
    relative_path: 'knowledge.json', absolute_path: path.join(root, 'knowledge.json'), mime_type: 'application/json',
    size_bytes: 2, sha256: createHash('sha256').update('{}').digest('hex'), status: 'active', created_at: createdAt, metadata: {},
  }, { id: randomUUID(), artifact_id: 'artifact-iq', version_number: 1, sha256: createHash('sha256').update('{}').digest('hex'), size_bytes: 2, created_at: createdAt, change_note: 'test' })
  database.createArtifactEvidenceLink({
    id: 'evidence-iq', artifact_id: 'artifact-iq', source_type: 'source', source_id: 'source-iq',
    relation_type: 'references', created_at: createdAt, metadata: { fixture: true },
  })
  video.attachArtifacts(document.id, { knowledge: 'artifact-iq' })
  return {
    root, database, video, retrieval: new SemanticRetrievalService(database, 'test-embedding', mockEndpoint),
    documentId: document.id, segmentId: segment!.id, pointId: point!.id,
  }
}

beforeAll(async () => {
  mockServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string[] | string }
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ embeddings: inputs.map(mockVector) }))
  })
  await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', resolve))
  const address = mockServer.address()
  if (address === null || typeof address === 'string') throw new Error('MOCK_SERVER_BIND_FAILED')
  mockEndpoint = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => mockServer.close(() => resolve()))
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe('STEP-30 Embedding Provider', () => {
  it('exposes the local fallback through the provider interface', async () => {
    const provider = new LocalHashEmbeddingProvider(256)
    expect((await provider.embedText('本机检索')).vector).toHaveLength(256)
    expect((await provider.health()).available).toBe(true)
    expect(provider.metadata().fallback_only).toBe(true)
  })

  it('calls a formal embedding endpoint', async () => {
    const provider = new OllamaEmbeddingProvider(mockEndpoint, 'test-embedding')
    const result = await provider.embedText('无线正交信号')
    expect(result.provider).toBe('ollama')
    expect(result.vector).toHaveLength(8)
  })

  it('supports batch embedding with fixed dimensions', async () => {
    const results = await new OllamaEmbeddingProvider(mockEndpoint, 'test-embedding').embedBatch(['无线信号', '路径授权'])
    expect(results.map(result => result.vector.length)).toEqual([8, 8])
    expect(results[0]?.vector).not.toEqual(results[1]?.vector)
  })

  it('keeps local vectors deterministic', () => expect(localHashEmbedding('same')).toEqual(localHashEmbedding('same')))
  it('computes cosine similarity without dimension coercion', () => expect(cosineSimilarity([1, 0], [1, 0])).toBe(1))
})

describe('STEP-30 versioned vector storage and retrieval', () => {
  it('stores Float32 vectors as BLOB and decodes them', () => {
    const vector = [0.25, -0.5, 0.75]
    expect(blobToVector(vectorToBlob(vector), vector.length)).toEqual(vector)
  })

  it('creates embedding_records without replacing inline vectors', async () => {
    const fixture = await temporaryDatabase()
    await fixture.retrieval.indexProject('project-a')
    const tables = fixture.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map(row => row.name)).toContain('embedding_records')
    expect(fixture.video.listSegments(fixture.documentId)[0]?.embedding_dimensions).toBe(256)
    fixture.database.close()
  })

  it('stores both baseline and formal embeddings for one Segment', async () => {
    const fixture = await temporaryDatabase()
    await fixture.retrieval.indexProject('project-a')
    const rows = fixture.database.db.prepare('SELECT provider, dimension FROM embedding_records WHERE entity_id=? AND is_active=1 ORDER BY provider').all(fixture.segmentId) as Array<{ provider: string; dimension: number }>
    expect(rows).toEqual([{ provider: 'local-hash-v1', dimension: 256 }, { provider: 'ollama', dimension: 8 }])
    fixture.database.close()
  })

  it('stores Knowledge Point embeddings separately', async () => {
    const fixture = await temporaryDatabase()
    await fixture.retrieval.indexProject('project-a')
    expect(fixture.retrieval.repository.getActive('knowledge_point', fixture.pointId, 'ollama', 'test-embedding')?.dimension).toBe(8)
    fixture.database.close()
  })

  it('marks the prior content vector stale after text changes', async () => {
    const fixture = await temporaryDatabase()
    await fixture.retrieval.indexProject('project-a')
    fixture.database.db.prepare('UPDATE video_knowledge_points SET summary=? WHERE id=?').run('路径授权发生变化，需要重新生成向量。', fixture.pointId)
    await fixture.retrieval.indexProject('project-a')
    const count = fixture.database.db.prepare('SELECT COUNT(*) AS count FROM embedding_records WHERE entity_id=? AND provider=? AND is_active=0').get(fixture.pointId, 'ollama') as { count: number }
    expect(Number(count.count)).toBe(1)
    fixture.database.close()
  })

  it('returns the semantic result with timestamp and deterministic citations', async () => {
    const fixture = await temporaryDatabase()
    const [result] = await fixture.retrieval.search({ query: '为什么无线通信要用互相垂直的两路信号', project_id: 'project-a', provider: 'semantic', top_k: 3 })
    expect(result?.segment_id).toBe(fixture.segmentId)
    expect(result?.start_ms).toBe(1_000)
    expect(result?.segment_citation).toContain('VideoSegment:segment-iq')
    fixture.database.close()
  })

  it('returns Artifact and Evidence summaries', async () => {
    const fixture = await temporaryDatabase()
    const [result] = await fixture.retrieval.search({ query: '无线正交信号', project_id: 'project-a', provider: 'semantic', top_k: 1 })
    expect(result?.artifact_id).toBe('artifact-iq')
    expect(result?.evidence_count).toBe(1)
    fixture.database.close()
  })

  it('enforces project isolation', async () => {
    const fixture = await temporaryDatabase()
    const results = await fixture.retrieval.search({ query: '无线正交信号', project_id: 'project-b', provider: 'semantic', top_k: 5 })
    expect(results).toEqual([])
    fixture.database.close()
  })

  it('enforces top-k limits', async () => {
    const fixture = await temporaryDatabase()
    await expect(fixture.retrieval.search({ query: '无线正交信号', provider: 'semantic', top_k: 21 })).rejects.toThrow('INVALID_RETRIEVAL_TOP_K')
    fixture.database.close()
  })

  it('distinguishes staged and approved indexes', async () => {
    const fixture = await temporaryDatabase()
    await fixture.retrieval.indexProject('project-a')
    expect(fixture.retrieval.repository.getActive('video_segment', fixture.segmentId, 'ollama', 'test-embedding')?.index_state).toBe('staged')
    fixture.retrieval.markDocumentApproved(fixture.documentId)
    expect(fixture.retrieval.repository.getActive('video_segment', fixture.segmentId, 'ollama', 'test-embedding')?.index_state).toBe('approved')
    fixture.database.close()
  })

  it('reports diagnostics and fallback availability', async () => {
    const fixture = await temporaryDatabase()
    await fixture.retrieval.indexProject('project-a')
    const diagnostics = await fixture.retrieval.diagnostics()
    expect(diagnostics.formal_provider_available).toBe(true)
    expect(diagnostics.fallback_available).toBe(true)
    expect(diagnostics.indexed_entities).toMatchObject({ total: 2, video_segments: 1, knowledge_points: 1, staged: 2 })
    fixture.database.close()
  })

  it('falls back when the formal provider is unavailable', async () => {
    const fixture = await temporaryDatabase()
    const unavailable = new SemanticRetrievalService(fixture.database, 'missing', 'http://127.0.0.1:1')
    const [result] = await unavailable.search({ query: '无线正交信号', project_id: 'project-a', provider: 'semantic', top_k: 1 })
    expect(result?.provider).toBe('local-hash-v1')
    expect(result?.fallback_used).toBe(true)
    fixture.database.close()
  })

  it('passes SQLite integrity and foreign key checks', async () => {
    const fixture = await temporaryDatabase()
    await fixture.retrieval.indexProject('project-a')
    expect(fixture.video.integrityCheck()).toEqual({ integrity: 'ok', foreignKeys: 0 })
    fixture.database.close()
  })

  it('keeps retrieval APIs behind the localhost token gate', async () => {
    const source = await readFile(path.resolve(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
    const gate = source.indexOf('X-Workbench-Token')
    const diagnosticsRoute = source.indexOf('/api/retrieval/diagnostics')
    const searchRoute = source.indexOf('/api/video/search')
    expect(source).toContain("const HOST = '127.0.0.1'")
    expect(source).toContain("request.headers['x-workbench-token'] === TOKEN")
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(diagnosticsRoute).toBeGreaterThan(gate)
    expect(searchRoute).toBeGreaterThan(gate)
  })

  it('limits media cleanup to the fixed runtime temp directory and explicit confirmation', async () => {
    const source = await readFile(path.resolve(import.meta.dirname, '..', 'src', 'video', 'cleanup.ts'), 'utf8')
    expect(source).toContain("path.join(PATHS.myAgentRoot, 'runtime', 'media', 'temp')")
    expect(source).toContain('MEDIA_TEMP_CLEANUP_CONFIRMATION_REQUIRED')
    expect(source).toContain('MEDIA_TEMP_CLEANUP_REPARSE_POINT_DENIED')
  })
})
