import { createHash } from 'node:crypto'

export interface EmbeddingResult {
  provider: 'ollama' | 'local-hash-v1'
  model: string
  vector: number[]
  diagnostic: string
  fallback_used?: boolean
  fallback_reason?: string | null
  elapsed_ms?: number
}

export interface EmbeddingProviderMetadata {
  provider: 'ollama' | 'local-hash-v1'
  model: string
  dimension: number | null
  runtime: 'node' | 'ollama'
  fallback_only: boolean
}

export interface EmbeddingProviderHealth {
  available: boolean
  provider: EmbeddingProviderMetadata['provider']
  model: string
  dimension: number | null
  latency_ms: number | null
  diagnostic: string
}

export interface EmbeddingProvider {
  embedText(text: string): Promise<EmbeddingResult>
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>
  health(): Promise<EmbeddingProviderHealth>
  metadata(): EmbeddingProviderMetadata
}

const DIMENSIONS = 256

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (magnitude === 0) return vector
  return vector.map(value => Number((value / magnitude).toFixed(8)))
}

export function localHashEmbedding(text: string, dimensions = DIMENSIONS): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 32 || dimensions > 4096) throw new Error('INVALID_EMBEDDING_DIMENSIONS')
  const vector = Array.from({ length: dimensions }, () => 0)
  const normalized = text.normalize('NFKC').toLowerCase()
  const tokens: string[] = []
  for (const word of normalized.split(/\s+/u).filter(Boolean)) tokens.push(word)
  const codepoints = [...normalized]
  for (let width = 1; width <= 3; width += 1) {
    for (let index = 0; index + width <= codepoints.length; index += 1) tokens.push(codepoints.slice(index, index + width).join(''))
  }
  for (const token of tokens) {
    const digest = createHash('sha256').update(token, 'utf8').digest()
    const slot = digest.readUInt32BE(0) % dimensions
    const sign = (digest[4]! & 1) === 0 ? 1 : -1
    vector[slot] = vector[slot]! + sign
  }
  return normalize(vector)
}

function requiredEmbeddingText(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 32_768 || value.includes('\0')) {
    throw new Error('INVALID_EMBEDDING_TEXT')
  }
  return value
}

function parseOllamaEmbeddings(value: unknown, expected: number): number[][] {
  if (value === null || typeof value !== 'object') throw new Error('OLLAMA_EMBEDDING_INVALID_RESPONSE')
  const raw = (value as { embeddings?: unknown }).embeddings
  if (!Array.isArray(raw) || raw.length !== expected) throw new Error('OLLAMA_EMBEDDING_INVALID_RESPONSE')
  const vectors: number[][] = []
  for (const vector of raw) {
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(item => typeof item === 'number' && Number.isFinite(item))) {
      throw new Error('OLLAMA_EMBEDDING_INVALID_VECTOR')
    }
    vectors.push(normalize(vector as number[]))
  }
  const dimension = vectors[0]!.length
  if (!vectors.every(vector => vector.length === dimension)) throw new Error('OLLAMA_EMBEDDING_DIMENSION_MISMATCH')
  return vectors
}

export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimensions = DIMENSIONS) {}

  metadata(): EmbeddingProviderMetadata {
    return { provider: 'local-hash-v1', model: 'unicode-ngram-sha256', dimension: this.dimensions, runtime: 'node', fallback_only: true }
  }

  async embedText(text: string): Promise<EmbeddingResult> {
    const started = performance.now()
    const vector = localHashEmbedding(requiredEmbeddingText(text), this.dimensions)
    return {
      provider: 'local-hash-v1', model: 'unicode-ngram-sha256', vector,
      diagnostic: '基础本地检索模式；使用确定性 Unicode n-gram 哈希向量。',
      fallback_used: false, fallback_reason: null, elapsed_ms: Number((performance.now() - started).toFixed(3)),
    }
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 256) throw new Error('INVALID_EMBEDDING_BATCH')
    return Promise.all(texts.map(text => this.embedText(text)))
  }

  async health(): Promise<EmbeddingProviderHealth> {
    const result = await this.embedText('health')
    return {
      available: true, provider: 'local-hash-v1', model: result.model, dimension: result.vector.length,
      latency_ms: result.elapsed_ms ?? null, diagnostic: result.diagnostic,
    }
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private observedDimension: number | null = null

  constructor(readonly endpoint: string, readonly model: string, readonly timeoutMs = 120_000) {
    if (!/^https?:\/\//u.test(endpoint)) throw new Error('INVALID_OLLAMA_ENDPOINT')
    if (model.trim().length === 0 || model.length > 128) throw new Error('INVALID_EMBEDDING_MODEL')
  }

  metadata(): EmbeddingProviderMetadata {
    return { provider: 'ollama', model: this.model, dimension: this.observedDimension, runtime: 'ollama', fallback_only: false }
  }

  async embedText(text: string): Promise<EmbeddingResult> {
    return (await this.embedBatch([text]))[0]!
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 256) throw new Error('INVALID_EMBEDDING_BATCH')
    const input = texts.map(requiredEmbeddingText)
    const started = performance.now()
    const response = await fetch(new URL('/api/embed', `${this.endpoint}/`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input, truncate: true, keep_alive: '5m' }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      throw new Error(`OLLAMA_EMBEDDING_FAILED: HTTP ${response.status} ${detail}`)
    }
    const vectors = parseOllamaEmbeddings(await response.json(), input.length)
    this.observedDimension = vectors[0]!.length
    const elapsed = Number((performance.now() - started).toFixed(3))
    return vectors.map(vector => ({
      provider: 'ollama', model: this.model, vector, diagnostic: `Ollama /api/embed · ${this.model}`,
      fallback_used: false, fallback_reason: null, elapsed_ms: elapsed,
    }))
  }

  async health(): Promise<EmbeddingProviderHealth> {
    const started = performance.now()
    try {
      const result = await this.embedText('本机 Embedding 健康检查')
      return {
        available: true, provider: 'ollama', model: this.model, dimension: result.vector.length,
        latency_ms: Number((performance.now() - started).toFixed(3)), diagnostic: result.diagnostic,
      }
    } catch (error) {
      return {
        available: false, provider: 'ollama', model: this.model, dimension: this.observedDimension,
        latency_ms: Number((performance.now() - started).toFixed(3)),
        diagnostic: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0; let leftMagnitude = 0; let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
    leftMagnitude += left[index]! ** 2
    rightMagnitude += right[index]! ** 2
  }
  return leftMagnitude === 0 || rightMagnitude === 0 ? 0 : dot / Math.sqrt(leftMagnitude * rightMagnitude)
}

export class LocalEmbeddingService {
  private ollamaAvailable: boolean | null = null

  constructor(readonly endpoint: string, readonly model: string, readonly dimensions = DIMENSIONS) {}

  async embed(text: string): Promise<EmbeddingResult> {
    if (this.ollamaAvailable !== false) {
      try {
        const response = await fetch(new URL('/api/embed', `${this.endpoint}/`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: text }),
          signal: AbortSignal.timeout(30_000),
        })
        if (response.ok) {
          const result = await response.json() as { embeddings?: unknown }
          const raw = Array.isArray(result.embeddings) && Array.isArray(result.embeddings[0]) ? result.embeddings[0] : null
          if (raw !== null && raw.length > 0 && raw.every(value => typeof value === 'number' && Number.isFinite(value))) {
            this.ollamaAvailable = true
            return { provider: 'ollama', model: this.model, vector: normalize(raw as number[]), diagnostic: 'Ollama /api/embed' }
          }
        }
        this.ollamaAvailable = false
      } catch {
        this.ollamaAvailable = false
      }
    }
    return {
      provider: 'local-hash-v1',
      model: 'unicode-ngram-sha256',
      vector: localHashEmbedding(text, this.dimensions),
      diagnostic: '当前 Ollama 模型没有提供 embedding 接口，使用本机确定性哈希向量。',
    }
  }
}
