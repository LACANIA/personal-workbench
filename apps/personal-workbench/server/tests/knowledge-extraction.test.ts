import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { KnowledgeDedupService } from '../src/knowledge/dedup.ts'
import {
  KNOWLEDGE_CARD_JSON_SCHEMA,
  KNOWLEDGE_EXTRACTION_PROMPT_VERSION,
  Qwen3KnowledgeExtractionProvider,
  type ExtractedKnowledgeCard,
  type KnowledgeExtractionProvider,
  validateKnowledgeCardPayload,
} from '../src/knowledge/extraction.ts'
import { GroundingValidator } from '../src/knowledge/grounding.ts'
import { KnowledgeCardService } from '../src/knowledge/service.ts'
import { SemanticRetrievalService } from '../src/retrieval/service.ts'
import { localHashEmbedding } from '../src/video/embedding.ts'
import { VideoKnowledgeRepository } from '../src/video/repository.ts'

const roots: string[] = []
let embeddingServer: Server
let embeddingEndpoint = ''

function extracted(title = 'IQ正交分量'): ExtractedKnowledgeCard {
  return {
    title, concept: 'I与Q正交分量', core_claim: 'I分量和Q分量在相位上相差九十度。',
    explanation: '正交表示同时保留幅度与相位信息。', keywords: ['I', 'Q', '正交'],
    relations: [{ type: 'related_to', target: '复数基带信号' }],
  }
}

class MockExtractionProvider implements KnowledgeExtractionProvider {
  calls = 0
  metadata() {
    return {
      provider: 'qwen3_local' as const, model: 'qwen3:8b', endpoint: 'http://127.0.0.1:11434',
      prompt_version: KNOWLEDGE_EXTRACTION_PROMPT_VERSION, prompt_sha256: 'a'.repeat(64),
      structured_output: 'json_schema' as const, temperature: 0, top_p: 0.8, thinking: false as const,
      context_length: 8192, repair_limit: 1,
    }
  }
  async health() { return { available: true, diagnostic: 'mock local model' } }
  async extract(segment: { id: string; text: string }) {
    this.calls += 1
    const cards = segment.text.includes('MULTI') ? [extracted('正交相位'), {
      title: '复数基带', concept: '复数基带信号', core_claim: '正交表示形成复数基带信号。',
      explanation: 'I与Q分量共同表达幅度与相位。', keywords: ['I', 'Q', '复数基带'], relations: [],
    }] : [extracted()]
    return {
      cards, source_segment_ids: [segment.id],
      metrics: { duration_ms: 12, prompt_tokens: 40, output_tokens: 30, load_duration_ms: 0, repair_count: 0 },
    }
  }
}

async function fixture(twoSegments = false): Promise<{
  root: string
  database: WorkbenchDatabase
  video: VideoKnowledgeRepository
  service: KnowledgeCardService
  provider: MockExtractionProvider
  documentId: string
  segmentIds: string[]
  taskId: string
  transcriptArtifactId: string
}> {
  const parent = path.join(PATHS.appRoot, 'data')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, 'step31-test-'))
  roots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  database.createProjectContext('project-step31', { name: 'STEP-31 Project', rootPath: root, description: '', projectType: 'research' })
  const taskId = randomUUID()
  database.createTask(taskId, {
    templateId: 'video-to-knowledge', inputType: 'subtitle', inputValue: path.join(root, 'fixture.srt'),
    workspacePath: root, projectName: 'STEP-31 Project', title: 'STEP-31 fixture',
  })
  const evidence = new ArtifactEvidenceService(database)
  const artifacts = new ArtifactService(database, evidence)
  const video = new VideoKnowledgeRepository(database)
  const job = video.createJob({ projectId: 'project-step31', taskId, inputType: 'subtitle', inputValue: 'fixture.srt', title: 'IQ课程', language: 'zh' })
  const document = video.createDocument({
    projectId: 'project-step31', jobId: job.id, title: 'IQ课程', sourceKind: 'subtitle', sourceReference: 'fixture.srt',
    language: 'zh', durationMs: 20_000, segmentCount: twoSegments ? 2 : 1, knowledgePointCount: twoSegments ? 2 : 1,
    metadata: { transcript_source: 'user_subtitle' },
  })
  const text = 'MULTI I分量和Q分量在相位上相差九十度，正交表示同时保留幅度与相位信息，并形成复数基带信号。'
  const segmentInputs = [text, ...(twoSegments ? [text] : [])]
  const segments = video.insertSegments(document.id, segmentInputs.map((item, index) => ({
    id: `segment-${index + 1}-${randomUUID()}`, index, startMs: index * 10_000, endMs: (index + 1) * 10_000,
    text: item, textHash: createHash('sha256').update(item).digest('hex'), embeddingProvider: 'local-hash-v1',
    embeddingModel: 'unicode-ngram-sha256', embedding: localHashEmbedding(item),
  })))
  video.insertKnowledgePoints(document.id, segments.map((segment, index) => ({
    segmentId: segment.id, title: `Legacy ${index + 1}`, summary: segment.text, keywords: ['I', 'Q', '正交'], confidence: 1,
  })))
  const output = path.join(root, 'output', 'video-knowledge', job.id)
  await mkdir(output, { recursive: true })
  const transcriptPath = path.join(output, 'transcript.md')
  await writeFile(transcriptPath, '# Transcript\n\n00:00 I与Q正交。\n', 'utf8')
  const transcript = await artifacts.register({ project_id: 'project-step31', task_id: taskId, file_path: transcriptPath, artifact_type: 'document' })
  video.attachArtifacts(document.id, { transcript: transcript.id })
  const retrieval = new SemanticRetrievalService(database, 'test-embedding', embeddingEndpoint)
  const provider = new MockExtractionProvider()
  const service = new KnowledgeCardService(database, video, artifacts, evidence, retrieval, provider)
  return { root, database, video, service, provider, documentId: document.id, segmentIds: segments.map(item => item.id), taskId, transcriptArtifactId: transcript.id }
}

beforeAll(async () => {
  embeddingServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string[] | string }
    const input = Array.isArray(payload.input) ? payload.input : [payload.input]
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ embeddings: input.map(value => {
      const vector = Array.from({ length: 16 }, () => 0)
      vector[createHash('sha256').update(value).digest()[0]! % vector.length] = 1
      return vector
    }) }))
  })
  await new Promise<void>(resolve => embeddingServer.listen(0, '127.0.0.1', resolve))
  const address = embeddingServer.address()
  if (address === null || typeof address === 'string') throw new Error('MOCK_EMBEDDING_BIND_FAILED')
  embeddingEndpoint = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => embeddingServer.close(() => resolve()))
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('STEP-31 extraction provider and validators', () => {
  it('publishes an exact JSON Schema with five-card maximum', () => {
    expect(KNOWLEDGE_CARD_JSON_SCHEMA.properties.cards.maxItems).toBe(5)
    expect(KNOWLEDGE_CARD_JSON_SCHEMA.properties.cards.items.additionalProperties).toBe(false)
  })

  it('accepts a valid card payload', () => expect(validateKnowledgeCardPayload({ cards: [extracted()] }).valid).toBe(true))

  it('rejects invalid JSON structure and excessive lengths', () => {
    const value = extracted('x'.repeat(31))
    expect(validateKnowledgeCardPayload({ cards: [value] }).valid).toBe(false)
  })

  it('rejects more than five cards', () => expect(validateKnowledgeCardPayload({ cards: Array.from({ length: 6 }, () => extracted()) }).valid).toBe(false))

  it('repairs one invalid response and then accepts valid JSON', async () => {
    let calls = 0
    const provider = new Qwen3KnowledgeExtractionProvider('http://127.0.0.1:11434', 'qwen3:8b', async () => ({
      message: { content: ++calls === 1 ? '{broken' : JSON.stringify({ cards: [extracted()] }) }, prompt_eval_count: 2, eval_count: 3,
    }))
    const result = await provider.extract({ id: 'segment', text: 'I和Q正交。', start_ms: 0, end_ms: 1 }, { video_title: 'IQ' })
    expect(result.metrics.repair_count).toBe(1)
    expect(calls).toBe(2)
  })

  it('stops after the configured repair limit', async () => {
    const provider = new Qwen3KnowledgeExtractionProvider('http://127.0.0.1:11434', 'qwen3:8b', async () => ({ message: { content: '{broken' } }))
    await expect(provider.extract({ id: 'segment', text: 'I和Q正交。', start_ms: 0, end_ms: 1 }, { video_title: 'IQ' }))
      .rejects.toThrow('KNOWLEDGE_EXTRACTION_INVALID')
  })

  it('flags numeric and acronym claims missing from source', () => {
    const validation = new GroundingValidator().validate({ ...extracted(), core_claim: 'I和Q相差90度并支持5G。' }, 'I和Q互相正交。')
    expect(validation.valid).toBe(false)
    expect(validation.unsupported_tokens).toEqual(expect.arrayContaining(['90', '5G']))
  })

  it('passes protected tokens present in source', () => {
    const validation = new GroundingValidator().validate(extracted(), 'I分量和Q分量相差九十度，正交表示同时保留幅度与相位信息，并形成复数基带信号。')
    expect(validation.valid).toBe(true)
  })
})

describe('STEP-31 Knowledge Card lifecycle', () => {
  it('stores structured cards without replacing Legacy Knowledge Points', async () => {
    const test = await fixture()
    const before = test.video.listKnowledgePoints(test.documentId)
    const result = await test.service.extractDocument(test.documentId)
    expect(result.cards).toHaveLength(2)
    expect(test.video.listKnowledgePoints(test.documentId)).toEqual(before)
    test.database.close()
  })

  it('links every card to a source Segment and timestamp', async () => {
    const test = await fixture()
    const result = await test.service.extractDocument(test.documentId)
    expect(result.cards.every(card => card.source_segment_ids.includes(card.segment_id))).toBe(true)
    expect(result.cards.every(card => card.source_end > card.source_start)).toBe(true)
    test.database.close()
  })

  it('allows multiple cards while enforcing the per-Segment cap through schema validation', async () => {
    const test = await fixture()
    const result = await test.service.extractDocument(test.documentId)
    expect(result.cards).toHaveLength(2)
    expect(result.cards.every(card => card.card_index < 5)).toBe(true)
    test.database.close()
  })

  it('registers a staged JSON Artifact with Task and transcript Evidence', async () => {
    const test = await fixture()
    const result = await test.service.extractDocument(test.documentId)
    const links = test.database.listArtifactEvidenceLinks(result.artifact.id)
    expect(result.artifact.absolute_path.endsWith('knowledge-cards.json')).toBe(true)
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: 'task', source_id: test.taskId, relation_type: 'generated_from' }),
      expect.objectContaining({ source_type: 'artifact', source_id: test.transcriptArtifactId, relation_type: 'derived_from' }),
    ]))
    expect(result.cards.every(card => card.status === 'staged')).toBe(true)
    test.database.close()
  })

  it('indexes cards with the fixed STEP-30 embedding model', async () => {
    const test = await fixture()
    const result = await test.service.extractDocument(test.documentId)
    await test.service.retrieval.indexProject('project-step31')
    const record = test.service.retrieval.repository.getActive('knowledge_card', result.cards[0]!.id, 'ollama', 'test-embedding')
    expect(record?.dimension).toBe(16)
    expect(result.cards[0]?.embedding_input_version).toBe('knowledge-card-embedding-v1')
    test.database.close()
  })

  it('marks identical source text from another Segment as same-source duplicate', async () => {
    const test = await fixture(true)
    const result = await test.service.extractDocument(test.documentId)
    expect(result.cards.some(card => card.duplicate_status === 'same_source_duplicate')).toBe(true)
    test.database.close()
  })

  it('marks cards outdated when source hash changes', async () => {
    const test = await fixture()
    const result = await test.service.extractDocument(test.documentId)
    test.database.db.prepare('UPDATE video_segments SET text=?, text_hash=? WHERE id=?')
      .run('来源已经改变。', createHash('sha256').update('来源已经改变。').digest('hex'), result.cards[0]!.segment_id)
    expect(test.service.cards.getCard(result.cards[0]!.id)?.source_state).toBe('outdated')
    test.database.close()
  })

  it('regenerates without overwriting the earlier card', async () => {
    const test = await fixture()
    const first = await test.service.extractDocument(test.documentId)
    const second = await test.service.regenerate(first.cards[0]!.id)
    expect(second.cards[0]?.supersedes_card_id).toBe(first.cards[0]!.id)
    expect(test.service.cards.getCard(first.cards[0]!.id)?.status).toBe('superseded')
    test.database.close()
  })

  it('records manual approval without publishing Research Memory', async () => {
    const test = await fixture()
    const result = await test.service.extractDocument(test.documentId)
    const detail = test.service.review(result.cards[0]!.id, 'approved', '人工抽样通过')
    expect(detail.card.status).toBe('approved')
    expect(detail.reviews[0]?.decision).toBe('approved')
    expect(test.video.getDocument(test.documentId)?.memory_state).toBe('staged')
    test.database.close()
  })

  it('returns a card detail with source, Artifact and Evidence', async () => {
    const test = await fixture()
    const result = await test.service.extractDocument(test.documentId)
    const detail = test.service.detail(result.cards[0]!.id)
    expect(detail.segment.id).toBe(result.cards[0]!.segment_id)
    expect(detail.artifact?.id).toBe(result.artifact.id)
    expect(detail.evidence.length).toBeGreaterThan(0)
    test.database.close()
  })

  it('keeps extraction routes behind localhost token validation', async () => {
    const source = await readFile(path.resolve(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
    const gate = source.indexOf("request.headers['x-workbench-token'] === TOKEN")
    expect(source.indexOf('/api/knowledge/diagnostics')).toBeGreaterThan(gate)
    expect(source.indexOf('const knowledgeDocumentMatch')).toBeGreaterThan(gate)
  })

  it('passes SQLite integrity and foreign-key checks after extraction', async () => {
    const test = await fixture()
    await test.service.extractDocument(test.documentId)
    expect(test.database.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(test.database.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    test.database.close()
  })
})

describe('STEP-31 duplicate service', () => {
  it('does not delete or merge candidates while reporting a duplicate', async () => {
    const provider = { embedBatch: async (texts: string[]) => texts.map(() => ({ provider: 'ollama' as const, model: 'test', dimension: 2, vector: [1, 0], latency_ms: 0 })), embedText: async () => ({ provider: 'ollama' as const, model: 'test', dimension: 2, vector: [1, 0], latency_ms: 0 }), health: async () => ({ available: true, provider: 'ollama' as const, model: 'test', dimension: 2, latency_ms: 0, diagnostic: 'ok' }), metadata: () => ({ provider: 'ollama' as const, model: 'test', dimension: 2, runtime: 'ollama' as const, endpoint: 'local', fallback_only: false }) }
    const base = {
      id: 'one', batch_id: 'b', video_document_id: 'd', segment_id: 's1', card_index: 0, ...extracted(),
      source_segment_ids: ['s1'], source_start: 0, source_end: 1, extractor_provider: 'qwen3_local' as const,
      extractor_model: 'qwen3:8b', prompt_version: 'v1', source_sha256: '1'.repeat(64), card_sha256: '2'.repeat(64),
      embedding_input_version: 'v1', status: 'staged' as const, validation_status: 'valid' as const, grounding_issues: [],
      duplicate_status: 'unique' as const, duplicate_of_card_id: null, source_state: 'current' as const, artifact_id: null,
      supersedes_card_id: null, created_at: '2026-01-01T00:00:00Z', citation: 'citation',
    }
    const candidate = { ...base, id: 'two', segment_id: 's2', source_sha256: '3'.repeat(64) }
    const decision = await new KnowledgeDedupService(provider, 0.9).compare(base, [candidate])
    expect(decision).toMatchObject({ status: 'possible_duplicate', duplicate_of_card_id: 'two' })
    expect(candidate.status).toBe('staged')
  })
})
