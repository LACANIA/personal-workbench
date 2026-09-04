import { createHash, randomUUID } from 'node:crypto'
import type { UnifiedDocumentRecord } from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { WorkbenchDatabase } from '../database.ts'
import { cosineSimilarity, LocalHashEmbeddingProvider, OllamaEmbeddingProvider, type EmbeddingProvider } from '../video/embedding.ts'
import { blobToVector, vectorToBlob } from '../retrieval/repository.ts'
import { planDocumentChunks } from './chunk-planner.ts'

export interface DocumentSearchResult {
  document_id: string
  title: string
  section: string
  source_anchor: string
  text: string
  score: number
}

export interface DocumentAnswer {
  answer: string
  citations: Array<Pick<DocumentSearchResult, 'title' | 'section' | 'source_anchor' | 'text' | 'score'>>
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function sectionFor(document: UnifiedDocumentRecord, anchor: string): string {
  return document.sections.find(item => anchor === item.source_anchor || anchor.startsWith(`${item.source_anchor}#`))?.heading ?? document.title
}
function validateQuery(value: unknown): string {
  if (typeof value !== 'string') throw new Error('DOCUMENT_SEARCH_QUERY_REQUIRED')
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.length < 1 || query.length > 1_000 || query.includes('\0')) throw new Error('DOCUMENT_SEARCH_QUERY_INVALID')
  return query
}

/** Local, staged-only index for UnifiedDocument chunks. It has no Research Memory dependency. */
export class DocumentSearchService {
  readonly semantic = new OllamaEmbeddingProvider(PATHS.ollamaEndpoint, PATHS.embeddingModel ?? 'qwen3-embedding:0.6b')
  readonly fallback = new LocalHashEmbeddingProvider()

  constructor(readonly database: WorkbenchDatabase) {}

  async index(document: UnifiedDocumentRecord): Promise<{ indexed: number; provider: string; model: string; fallback: boolean }> {
    // Retrieval citations should retain the natural page/slide/heading boundary.
    // Large individual sections are still split by the existing safe planner.
    const chunks = document.sections.flatMap(section => planDocumentChunks([section]).map((chunk, index) => ({ ...chunk, index })))
      .map((chunk, index) => ({ ...chunk, index: index + 1 }))
    let provider: EmbeddingProvider = this.semantic
    let fallback = false
    const health = await this.semantic.health()
    if (!health.available) { provider = this.fallback; fallback = true }
    const vectors = await provider.embedBatch(chunks.map(chunk => chunk.text))
    const metadata = provider.metadata()
    const timestamp = new Date().toISOString()
    this.database.db.prepare('DELETE FROM document_chunk_indexes WHERE document_id=? AND provider=? AND model=?').run(document.id, metadata.provider, metadata.model)
    for (const [index, chunk] of chunks.entries()) {
      const result = vectors[index]!
      const contentHash = sha256(chunk.text)
      this.database.db.prepare(`
        INSERT INTO document_chunk_indexes(id,document_id,project_id,chunk_index,section_title,source_anchor,content,content_sha256,provider,model,dimension,vector_blob,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(document_id,chunk_index,provider,model,content_sha256) DO UPDATE SET vector_blob=excluded.vector_blob,dimension=excluded.dimension,created_at=excluded.created_at
      `).run(randomUUID(), document.id, document.project_id, chunk.index, sectionFor(document, chunk.anchors[0] ?? ''), chunk.anchors.join('、'), chunk.text, contentHash, result.provider, result.model, result.vector.length, vectorToBlob(result.vector), timestamp)
    }
    return { indexed: chunks.length, provider: metadata.provider, model: metadata.model, fallback }
  }

  async search(input: { query: unknown; document_id?: string; project_id?: string; top_k?: unknown }): Promise<DocumentSearchResult[]> {
    const query = validateQuery(input.query)
    const topK = Math.min(10, Math.max(1, Number.isFinite(Number(input.top_k)) ? Math.floor(Number(input.top_k)) : 5))
    const semanticHealth = await this.semantic.health()
    const provider = semanticHealth.available ? this.semantic : this.fallback
    const queryVector = (await provider.embedText(query)).vector
    const metadata = provider.metadata()
    const where = ['provider=?', 'model=?']
    const values: Array<string> = [metadata.provider, metadata.model]
    if (input.document_id !== undefined) { where.push('document_id=?'); values.push(input.document_id) }
    if (input.project_id !== undefined) { where.push('project_id=?'); values.push(input.project_id) }
    const rows = this.database.db.prepare(`
      SELECT i.document_id,i.section_title,i.source_anchor,i.content,i.dimension,i.vector_blob,d.title
      FROM document_chunk_indexes i JOIN unified_documents d ON d.id=i.document_id
      WHERE ${where.join(' AND ')}
    `).all(...values) as Array<Record<string, unknown>>
    return rows.map(row => ({
      document_id: String(row.document_id), title: String(row.title), section: String(row.section_title), source_anchor: String(row.source_anchor), text: String(row.content),
      score: cosineSimilarity(queryVector, blobToVector(row.vector_blob, Number(row.dimension))),
    })).sort((left, right) => right.score - left.score).slice(0, topK)
  }

  async ask(input: { query: unknown; document_id: string; project_id?: string; top_k?: unknown }): Promise<DocumentAnswer> {
    const query = validateQuery(input.query)
    const results = await this.search(input)
    if (results.length === 0) return { answer: '当前资料中没有找到明确说明。', citations: [] }
    const evidence = results.map((result, index) => `[片段 ${index + 1} · ${result.source_anchor}]\n${result.text.slice(0, 4_000)}`).join('\n\n')
    const response = await fetch(new URL('/api/chat', `${PATHS.ollamaEndpoint}/`), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({ model: 'qwen3:8b', stream: false, think: false, keep_alive: '5m', options: { temperature: 0, seed: 42, num_ctx: 16_384, num_predict: 700 }, messages: [
        { role: 'system', content: '你是本地资料问答助手。只可依据给定资料片段回答；找不到明确说明时，原样回答“当前资料中没有找到明确说明。”。不要编造页码、事实或来源。' },
        { role: 'user', content: `问题：${query}\n\n资料片段：\n${evidence}` },
      ] }),
    })
    if (!response.ok) throw new Error(`DOCUMENT_ANSWER_HTTP_${response.status}`)
    const payload = await response.json() as { message?: { content?: unknown } }
    const answer = typeof payload.message?.content === 'string' ? payload.message.content.trim().slice(0, 2_000) : ''
    return { answer: answer || '当前资料中没有找到明确说明。', citations: results.map(({ title, section, source_anchor, text, score }) => ({ title, section, source_anchor, text, score })) }
  }
}
