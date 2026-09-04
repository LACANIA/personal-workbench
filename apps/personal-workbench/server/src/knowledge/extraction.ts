import { createHash } from 'node:crypto'
import type { KnowledgeCardRelation } from '../../../shared/contracts/index.ts'

export const KNOWLEDGE_EXTRACTION_PROMPT_VERSION = 'knowledge-extraction-v1'
export const KNOWLEDGE_EXTRACTION_MODEL = 'qwen3:8b'
export const KNOWLEDGE_EXTRACTION_TEMPERATURE = 0
export const KNOWLEDGE_EXTRACTION_TOP_P = 0.8
export const KNOWLEDGE_EXTRACTION_CONTEXT_LENGTH = 8192
export const KNOWLEDGE_EXTRACTION_MAX_CARDS = 5

export const KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT = `你是本机结构化知识提取器。严格遵循以下规则：
1. 只使用 MAIN_SEGMENT 中直接出现的信息；视频标题和相邻片段只用于消除指代歧义。
2. 禁止补充外部知识、常识、评价、用途、原因、数字、单位、型号或缩写展开。
3. 保留来源中的技术限定、数字、单位、正负关系和因果方向。
4. 将事实写入 core_claim，将来源中已有的解释写入 explanation，将明确关系写入 relations。
5. 删除口语重复、开场语、结束语和主持人口头填充词。
6. 每个独立主题生成一张简洁知识卡，每个片段最多五张；没有第二个独立主题时只生成一张。
7. title、concept、core_claim、explanation 和 keywords 必须能够由 MAIN_SEGMENT 核对。
8. 只输出符合给定 JSON Schema 的对象，不输出 Markdown，不输出分析过程。`

export const KNOWLEDGE_EXTRACTION_PROMPT_SHA256 = createHash('sha256').update(KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT, 'utf8').digest('hex')

export const KNOWLEDGE_CARD_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cards'],
  properties: {
    cards: {
      type: 'array', minItems: 1, maxItems: KNOWLEDGE_EXTRACTION_MAX_CARDS,
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'concept', 'core_claim', 'explanation', 'keywords', 'relations'],
        properties: {
          title: { type: 'string', maxLength: 30 },
          concept: { type: 'string', maxLength: 40 },
          core_claim: { type: 'string', maxLength: 100 },
          explanation: { type: 'string', maxLength: 300 },
          keywords: { type: 'array', minItems: 3, maxItems: 8, items: { type: 'string', maxLength: 32 } },
          relations: {
            type: 'array', maxItems: 8,
            items: {
              type: 'object', additionalProperties: false, required: ['type', 'target'],
              properties: {
                type: { type: 'string', enum: ['causes', 'contrasts_with', 'part_of', 'requires', 'explains', 'related_to'] },
                target: { type: 'string', maxLength: 80 },
              },
            },
          },
        },
      },
    },
  },
} as const

const RELATION_TYPES = new Set(['causes', 'contrasts_with', 'part_of', 'requires', 'explains', 'related_to'])

export interface ExtractableSegment {
  id: string
  text: string
  start_ms: number
  end_ms: number
}

export interface KnowledgeExtractionContext {
  video_title: string
  previous_segment?: ExtractableSegment
  next_segment?: ExtractableSegment
}

export interface ExtractedKnowledgeCard {
  title: string
  concept: string
  core_claim: string
  explanation: string
  keywords: string[]
  relations: KnowledgeCardRelation[]
}

export interface KnowledgeExtractionCallMetrics {
  duration_ms: number
  prompt_tokens: number
  output_tokens: number
  load_duration_ms: number
  repair_count: number
}

export interface KnowledgeExtractionResponse {
  cards: ExtractedKnowledgeCard[]
  source_segment_ids: string[]
  metrics: KnowledgeExtractionCallMetrics
}

export interface KnowledgeExtractionMetadata {
  provider: 'qwen3_local'
  model: string
  endpoint: string
  prompt_version: string
  prompt_sha256: string
  structured_output: 'json_schema'
  temperature: number
  top_p: number
  thinking: false
  context_length: number
  repair_limit: number
}

export interface KnowledgeExtractionProvider {
  extract(segment: ExtractableSegment, context: KnowledgeExtractionContext): Promise<KnowledgeExtractionResponse>
  health(): Promise<{ available: boolean; diagnostic: string }>
  metadata(): KnowledgeExtractionMetadata
}

export interface OllamaChatResponse {
  message?: { content?: string }
  done?: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  eval_count?: number
}

export type KnowledgeExtractionTransport = (payload: Record<string, unknown>) => Promise<OllamaChatResponse>

function parseJsonCandidate(value: string): unknown {
  const normalized = value.trim()
  try { return JSON.parse(normalized) as unknown } catch { /* Check a single JSON code fence below. */ }
  const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)
  if (fenced === null) return null
  try { return JSON.parse(fenced[1]!) as unknown } catch { return null }
}

function charLength(value: string): number { return [...value].length }

function requiredString(value: unknown, field: string, maximum: number, errors: string[]): string {
  if (typeof value !== 'string') { errors.push(`${field}:type`); return '' }
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
  if (normalized.length === 0) errors.push(`${field}:empty`)
  if (charLength(normalized) > maximum) errors.push(`${field}:length`)
  return normalized
}

export function validateKnowledgeCardPayload(value: unknown): { valid: true; cards: ExtractedKnowledgeCard[] } | { valid: false; errors: string[] } {
  const errors: string[] = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['root:type'] }
  const root = value as Record<string, unknown>
  if (Object.keys(root).some(key => key !== 'cards')) errors.push('root:additional_property')
  if (!Array.isArray(root.cards) || root.cards.length < 1 || root.cards.length > KNOWLEDGE_EXTRACTION_MAX_CARDS) {
    return { valid: false, errors: [...errors, 'cards:count'] }
  }
  const cards: ExtractedKnowledgeCard[] = []
  root.cards.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`cards.${index}:type`); return }
    const card = raw as Record<string, unknown>
    const allowed = new Set(['title', 'concept', 'core_claim', 'explanation', 'keywords', 'relations'])
    if (Object.keys(card).some(key => !allowed.has(key))) errors.push(`cards.${index}:additional_property`)
    const title = requiredString(card.title, `cards.${index}.title`, 30, errors)
    const concept = requiredString(card.concept, `cards.${index}.concept`, 40, errors)
    const coreClaim = requiredString(card.core_claim, `cards.${index}.core_claim`, 100, errors)
    const explanation = requiredString(card.explanation, `cards.${index}.explanation`, 300, errors)
    const keywords: string[] = []
    if (!Array.isArray(card.keywords) || card.keywords.length < 3 || card.keywords.length > 8) errors.push(`cards.${index}.keywords:count`)
    else card.keywords.forEach((keyword, keywordIndex) => keywords.push(requiredString(keyword, `cards.${index}.keywords.${keywordIndex}`, 32, errors)))
    if (new Set(keywords.map(keyword => keyword.toLowerCase())).size !== keywords.length) errors.push(`cards.${index}.keywords:duplicate`)
    const relations: KnowledgeCardRelation[] = []
    if (!Array.isArray(card.relations) || card.relations.length > 8) errors.push(`cards.${index}.relations:count`)
    else card.relations.forEach((rawRelation, relationIndex) => {
      if (rawRelation === null || typeof rawRelation !== 'object' || Array.isArray(rawRelation)) { errors.push(`cards.${index}.relations.${relationIndex}:type`); return }
      const relation = rawRelation as Record<string, unknown>
      if (Object.keys(relation).some(key => key !== 'type' && key !== 'target')) errors.push(`cards.${index}.relations.${relationIndex}:additional_property`)
      const type = typeof relation.type === 'string' ? relation.type : ''
      if (!RELATION_TYPES.has(type)) errors.push(`cards.${index}.relations.${relationIndex}.type`)
      const target = requiredString(relation.target, `cards.${index}.relations.${relationIndex}.target`, 80, errors)
      if (RELATION_TYPES.has(type)) relations.push({ type: type as KnowledgeCardRelation['type'], target })
    })
    cards.push({ title, concept, core_claim: coreClaim, explanation, keywords, relations })
  })
  return errors.length === 0 ? { valid: true, cards } : { valid: false, errors }
}

function renderUserPrompt(segment: ExtractableSegment, context: KnowledgeExtractionContext): string {
  const previous = context.previous_segment === undefined ? '无' : context.previous_segment.text.slice(0, 500)
  const next = context.next_segment === undefined ? '无' : context.next_segment.text.slice(0, 500)
  return `VIDEO_TITLE:\n${context.video_title.slice(0, 240)}\n\nPREVIOUS_CONTEXT_ONLY:\n${previous}\n\nMAIN_SEGMENT_ID:${segment.id}\nMAIN_TIME_MS:${segment.start_ms}-${segment.end_ms}\n<MAIN_SEGMENT>\n${segment.text}\n</MAIN_SEGMENT>\n\nNEXT_CONTEXT_ONLY:\n${next}`
}

export class Qwen3KnowledgeExtractionProvider implements KnowledgeExtractionProvider {
  readonly repairLimit = 2
  constructor(
    readonly endpoint = 'http://127.0.0.1:11434',
    readonly model = KNOWLEDGE_EXTRACTION_MODEL,
    readonly transport: KnowledgeExtractionTransport = async payload => {
      const response = await fetch(new URL('/api/chat', `${endpoint}/`), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error(`KNOWLEDGE_EXTRACTION_HTTP_${response.status}`)
      return response.json() as Promise<OllamaChatResponse>
    },
  ) {}

  metadata(): KnowledgeExtractionMetadata {
    return {
      provider: 'qwen3_local', model: this.model, endpoint: this.endpoint,
      prompt_version: KNOWLEDGE_EXTRACTION_PROMPT_VERSION, prompt_sha256: KNOWLEDGE_EXTRACTION_PROMPT_SHA256,
      structured_output: 'json_schema', temperature: KNOWLEDGE_EXTRACTION_TEMPERATURE,
      top_p: KNOWLEDGE_EXTRACTION_TOP_P, thinking: false, context_length: KNOWLEDGE_EXTRACTION_CONTEXT_LENGTH,
      repair_limit: this.repairLimit,
    }
  }

  async health(): Promise<{ available: boolean; diagnostic: string }> {
    try {
      const response = await fetch(new URL('/api/tags', `${this.endpoint}/`), { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) return { available: false, diagnostic: `HTTP ${response.status}` }
      const body = await response.json() as { models?: Array<{ name?: string }> }
      const available = (body.models ?? []).some(item => item.name === this.model)
      return { available, diagnostic: available ? `Ollama JSON Schema · ${this.model}` : `模型未安装：${this.model}` }
    } catch (error) { return { available: false, diagnostic: error instanceof Error ? error.message : String(error) } }
  }

  async extract(segment: ExtractableSegment, context: KnowledgeExtractionContext): Promise<KnowledgeExtractionResponse> {
    const started = performance.now()
    let repairCount = 0
    let messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: renderUserPrompt(segment, context) },
    ]
    let latestMetrics: OllamaChatResponse = {}
    let lastErrors: string[] = ['unknown']
    for (let attempt = 0; attempt <= this.repairLimit; attempt += 1) {
      const body = await this.transport({
        model: this.model, stream: false, think: false, format: KNOWLEDGE_CARD_JSON_SCHEMA, keep_alive: '5m',
        options: {
          temperature: KNOWLEDGE_EXTRACTION_TEMPERATURE, top_p: KNOWLEDGE_EXTRACTION_TOP_P,
          seed: 42, num_ctx: KNOWLEDGE_EXTRACTION_CONTEXT_LENGTH, num_predict: 2048,
        },
        messages,
      })
      latestMetrics = body
      const content = String(body.message?.content ?? '')
      const parsed = parseJsonCandidate(content)
      const validated = validateKnowledgeCardPayload(parsed)
      if (validated.valid) {
        return {
          cards: validated.cards,
          source_segment_ids: [context.previous_segment?.id, segment.id, context.next_segment?.id].filter((id): id is string => id !== undefined),
          metrics: {
            duration_ms: Number((performance.now() - started).toFixed(3)),
            prompt_tokens: Number(body.prompt_eval_count ?? 0), output_tokens: Number(body.eval_count ?? 0),
            load_duration_ms: Number(((body.load_duration ?? 0) / 1_000_000).toFixed(3)), repair_count: repairCount,
          },
        }
      }
      lastErrors = validated.valid ? [] : validated.errors
      if (attempt >= this.repairLimit) break
      repairCount += 1
      messages = [
        { role: 'system', content: `${KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT}\n上一次输出未通过校验，只修复 JSON 结构和长度，禁止增加事实。` },
        { role: 'user', content: `${renderUserPrompt(segment, context)}\n\nVALIDATION_ERRORS:\n${validated.errors.join(', ')}\n\nINVALID_OUTPUT:\n${content.slice(0, 6_000)}` },
      ]
    }
    void latestMetrics
    throw new Error(`KNOWLEDGE_EXTRACTION_INVALID:${lastErrors.slice(0, 20).join(',')}`)
  }
}
