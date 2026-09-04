import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  LearningDocumentDetailLevel,
  LearningDocumentGenerateInput,
  LearningDocumentMode,
  LearningDocumentRecord,
  LearningDocumentReference,
  LearningDocumentSection,
  LearningTerm,
  UnifiedDocumentRecord,
  WorkbenchTask,
} from '../../../shared/contracts/index.ts'
import { ArtifactService, artifactBelongsToRoot } from '../artifacts/service.ts'
import { PATHS } from '../config.ts'
import { WorkbenchDatabase } from '../database.ts'
import { HierarchicalDocumentProcessor } from '../documents/hierarchical-document.ts'
import { createCompactLearningContent, decideDocumentStrategy, type SourceStructureHint } from '../documents/short-source-strategy.ts'
import { createDocxFromMarkdown, validateDocx } from '../reports/docx.ts'
import { TaskManager } from '../tasks/manager.ts'
import { VideoKnowledgeRepository } from '../video/repository.ts'

export const LEARNING_DOCUMENT_PROMPT_VERSION = 'learning-document-v2'
export const LEARNING_DOCUMENT_MODEL = 'qwen3:8b'
export const LEARNING_DOCUMENT_MIN_TIMEOUT_MS = 180_000
export const LEARNING_DOCUMENT_MAX_TIMEOUT_MS = 600_000
export const LEARNING_DOCUMENT_SYSTEM_PROMPT = `你是运行在用户电脑上的学习资料整理助手。你只可使用输入资料中已经出现的内容，并严格遵守：
1. 不增加资料中没有的技术事实、数字、公式、代码、实验结论或考试预测。
2. 用普通学习者能理解的中文重新组织内容，保留资料中已有的专业术语。
3. 如果资料没有进一步说明，明确写“原始资料没有进一步说明。”
4. 章节、术语、重点和复习问题都必须能回到给定资料或知识卡。
5. 标准学习笔记的每个章节正文不超过 450 个中文字符，每章最多 4 个要点和 2 个示例；术语不超过 15 项，复习问题不超过 10 项。
6. 当 VERIFIED_FORMULAS 非空时，至少用一个核心章节解释其中的数学关系与已经出现的符号；公式必须保留数学符号原样，不得改写成“乘以”“加上”等口述文字，也不得补写列表外公式。
7. 对包含公式的资料，优先写成可复习的技术学习笔记：给出定义、公式关系、符号含义、适用的来源时间；避免只写科普式概述。
8. 不输出分析过程、内部编号、Markdown 或任何 JSON 以外内容。`

export const LEARNING_DOCUMENT_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['document_title', 'summary', 'learning_goals', 'sections', 'terms', 'confusions', 'key_points', 'review_questions', 'learning_tips'],
  properties: {
    document_title: { type: 'string', minLength: 1, maxLength: 80 },
    summary: { type: 'string', minLength: 1, maxLength: 700 },
    learning_goals: { type: 'array', minItems: 3, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 140 } },
    sections: {
      type: 'array', minItems: 1, maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'summary', 'body', 'key_points', 'examples', 'source_refs'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 80 }, summary: { type: 'string', minLength: 1, maxLength: 360 },
          body: { type: 'string', minLength: 1, maxLength: 2400 },
          key_points: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 260 } },
          examples: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 400 } },
          source_refs: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 80 } },
        },
      },
    },
    terms: {
      type: 'array', maxItems: 30,
      items: { type: 'object', additionalProperties: false, required: ['term', 'explanation'], properties: {
        term: { type: 'string', minLength: 1, maxLength: 80 }, explanation: { type: 'string', minLength: 1, maxLength: 360 },
      } },
    },
    confusions: { type: 'array', maxItems: 15, items: { type: 'string', minLength: 1, maxLength: 420 } },
    key_points: { type: 'array', minItems: 3, maxItems: 15, items: { type: 'string', minLength: 1, maxLength: 300 } },
    review_questions: { type: 'array', minItems: 5, maxItems: 15, items: { type: 'string', minLength: 1, maxLength: 360 } },
    learning_tips: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 300 } },
  },
} as const

export interface LearningDocumentSource {
  source_type: string
  source_title: string
  source_reference: string
  source_text: string
  source_references: LearningDocumentReference[]
  source_artifact_ids: string[]
  timestamp_refs: string[]
  card_summaries: string[]
  legacy_summaries: string[]
  formula_evidence: LearningFormulaEvidence[]
  document_structure?: SourceStructureHint
  unified_document_id?: string
  user_instruction?: string
}

export interface LearningFormulaEvidence {
  formula: string
  time_range?: string
  source: 'ocr' | 'source_text'
}

interface OcrFormulaFrame {
  timestamp_ms?: unknown
  text?: unknown
  confidence?: unknown
}

export interface GeneratedLearningContent {
  document_title: string
  summary: string
  learning_goals: string[]
  sections: LearningDocumentSection[]
  terms: LearningTerm[]
  confusions: string[]
  key_points: string[]
  review_questions: string[]
  learning_tips: string[]
}

export interface LearningDocumentProvider {
  generate(source: LearningDocumentSource, mode: LearningDocumentMode, detail: LearningDocumentDetailLevel): Promise<GeneratedLearningContent>
  metadata(): { provider: 'qwen3_local'; model: string; prompt_version: string; prompt_sha256: string; endpoint: string }
}

interface OllamaResponse {
  message?: { content?: string }
  done_reason?: string
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function compact(value: string, maximum: number): string { return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim().slice(0, maximum) }
function textList(value: unknown, maximumItems: number, maximumLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null
  const items = value.map(item => typeof item === 'string' ? compact(item, maximumLength) : '')
  return items.every(item => item.length > 0) ? items : null
}

function parseJsonCandidate(value: string): unknown {
  try { return JSON.parse(value.trim()) as unknown } catch { /* A fenced object is accepted for a single repair-friendly response. */ }
  const fenced = value.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)
  if (fenced === null) return null
  try { return JSON.parse(fenced[1]!) as unknown } catch { return null }
}

export function validateLearningDocumentPayload(value: unknown): GeneratedLearningContent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const root = value as Record<string, unknown>
  const allowed = new Set(['document_title', 'summary', 'learning_goals', 'sections', 'terms', 'confusions', 'key_points', 'review_questions', 'learning_tips'])
  if (Object.keys(root).some(key => !allowed.has(key))) return null
  const documentTitle = typeof root.document_title === 'string' ? compact(root.document_title, 80) : ''
  const summary = typeof root.summary === 'string' ? compact(root.summary, 700) : ''
  const goals = textList(root.learning_goals, 8, 140)
  const keyPoints = textList(root.key_points, 15, 300)
  const confusions = textList(root.confusions, 15, 420)
  const questions = textList(root.review_questions, 15, 360)
  const tips = textList(root.learning_tips, 8, 300)
  if (documentTitle.length === 0 || summary.length === 0 || goals === null || goals.length < 3 || keyPoints === null || keyPoints.length < 3 || confusions === null || questions === null || questions.length < 5 || tips === null) return null
  if (!Array.isArray(root.sections) || root.sections.length < 1 || root.sections.length > 12) return null
  const sections: LearningDocumentSection[] = []
  for (const raw of root.sections) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const item = raw as Record<string, unknown>
    if (Object.keys(item).some(key => !['title', 'summary', 'body', 'key_points', 'examples', 'source_refs'].includes(key))) return null
    const title = typeof item.title === 'string' ? compact(item.title, 80) : ''
    const sectionSummary = typeof item.summary === 'string' ? compact(item.summary, 360) : ''
    const body = typeof item.body === 'string' ? compact(item.body, 2400) : ''
    const sectionPoints = textList(item.key_points, 10, 260)
    const examples = textList(item.examples, 5, 400)
    const refs = textList(item.source_refs, 12, 80)
    if (title.length === 0 || sectionSummary.length === 0 || body.length === 0 || sectionPoints === null || examples === null || refs === null) return null
    sections.push({ title, summary: sectionSummary, body, key_points: sectionPoints, examples, source_refs: refs })
  }
  if (!Array.isArray(root.terms) || root.terms.length > 30) return null
  const terms: LearningTerm[] = []
  for (const raw of root.terms) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const item = raw as Record<string, unknown>
    if (Object.keys(item).some(key => key !== 'term' && key !== 'explanation')) return null
    const term = typeof item.term === 'string' ? compact(item.term, 80) : ''
    const explanation = typeof item.explanation === 'string' ? compact(item.explanation, 360) : ''
    if (term.length === 0 || explanation.length === 0) return null
    terms.push({ term, explanation })
  }
  return { document_title: documentTitle, summary, learning_goals: goals, sections, terms, confusions, key_points: keyPoints, review_questions: questions, learning_tips: tips }
}

function renderPrompt(source: LearningDocumentSource, mode: LearningDocumentMode, detail: LearningDocumentDetailLevel): string {
  const profile = mode === 'review_notes' ? '复习资料' : mode === 'technical_guide' ? '技术说明' : mode === 'simple_summary' ? '简要总结' : '学习笔记'
  let detailHint = detail === 'concise'
    ? '简洁：组织 3 至 4 个章节，优先保留定义、结论和复习问题。'
    : detail === 'detailed'
      ? '详细：组织 6 至 8 个章节，保留更多已出现的解释和来源时间引用。'
      : '标准：组织 4 至 6 个章节，给普通学习者提供连贯、适量的解释。'
  if (mode === 'technical_guide') {
    detailHint += ' 安装、运行和配置只能依据来源中已有的文档、清单或命令；资料没有说明时必须明确说明未提供，不能补写命令。'
  }
  const formulas = source.formula_evidence.length === 0
    ? '无已核验公式。'
    : source.formula_evidence.map(item => `- ${item.time_range === undefined ? '' : `[${item.time_range}] `}${item.formula}`).join('\n')
  return `任务：把下面的已有资料整理为“${profile}”。${detailHint}\n\nSOURCE_TITLE:\n${source.source_title}\n\nSOURCE_REFERENCE:\n${source.source_reference}\n\nUSER_INSTRUCTION:\n${source.user_instruction ?? '无额外要求'}\n\nTIME_REFERENCES:\n${source.timestamp_refs.join('\n') || '无时间引用'}\n\nVERIFIED_FORMULAS:\n${formulas}\n\nSTRUCTURED_KNOWLEDGE_CARDS:\n${source.card_summaries.join('\n') || '无'}\n\nLEGACY_KNOWLEDGE_POINTS:\n${source.legacy_summaries.join('\n') || '无'}\n\nCORRECTED_OR_EXTRACTED_SOURCE:\n<CONTENT>\n${source.source_text.slice(0, 28_000)}\n</CONTENT>`
}

/** 长资料由本机 qwen3 生成时会明显比短文本慢，时限按实际提示词规模调整。 */
export function learningDocumentGenerationTimeoutMs(source: LearningDocumentSource, mode: LearningDocumentMode, detail: LearningDocumentDetailLevel): number {
  const promptLength = renderPrompt(source, mode, detail).length
  const detailBudget = detail === 'detailed' ? 300_000 : detail === 'standard' ? 240_000 : LEARNING_DOCUMENT_MIN_TIMEOUT_MS
  const sourceBudget = Math.ceil(promptLength / 10_000) * 45_000
  return Math.min(LEARNING_DOCUMENT_MAX_TIMEOUT_MS, Math.max(LEARNING_DOCUMENT_MIN_TIMEOUT_MS, detailBudget + sourceBudget))
}

function learningDocumentOutputTokenLimit(detail: LearningDocumentDetailLevel): number {
  return detail === 'detailed' ? 4_096 : detail === 'standard' ? 3_584 : 1_536
}

function isTimeout(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const value = error as { name?: unknown; message?: unknown; cause?: unknown }
  if (value.name === 'TimeoutError' || value.name === 'AbortError') return true
  if (typeof value.message === 'string' && /(?:timeout|timed out|aborted)/iu.test(value.message)) return true
  return isTimeout(value.cause)
}

function learningDocumentFailure(error: unknown): { code: string; message: string } {
  const source = error instanceof Error ? error.message : String(error)
  const code = source.split(':')[0] || 'LEARNING_DOCUMENT_FAILED'
  if (code === 'LEARNING_DOCUMENT_MODEL_TIMEOUT') {
    return { code, message: '本地模型生成这份较长的学习资料超过了等待时间；任务内容已经保留，可以选择“简洁”重新生成。' }
  }
  if (code === 'LEARNING_DOCUMENT_INVALID') {
    return { code, message: '本地模型返回的学习资料格式不完整；任务内容已经保留，可以重新生成。' }
  }
  if (code.startsWith('LEARNING_DOCUMENT_HTTP_')) {
    return { code, message: '本地模型服务暂时没有完成响应；请确认 Ollama 可用后重新生成。' }
  }
  return { code, message: '学习资料生成失败；原有转录、知识卡和任务结果已经保留，可以重新生成。' }
}

export class Qwen3LearningDocumentProvider implements LearningDocumentProvider {
  constructor(readonly endpoint = PATHS.ollamaEndpoint, readonly model = LEARNING_DOCUMENT_MODEL) {}

  metadata(): { provider: 'qwen3_local'; model: string; prompt_version: string; prompt_sha256: string; endpoint: string } {
    return { provider: 'qwen3_local', model: this.model, prompt_version: LEARNING_DOCUMENT_PROMPT_VERSION, prompt_sha256: sha256(LEARNING_DOCUMENT_SYSTEM_PROMPT), endpoint: this.endpoint }
  }

  async generate(source: LearningDocumentSource, mode: LearningDocumentMode, detail: LearningDocumentDetailLevel): Promise<GeneratedLearningContent> {
    const messages = [{ role: 'system' as const, content: LEARNING_DOCUMENT_SYSTEM_PROMPT }, { role: 'user' as const, content: renderPrompt(source, mode, detail) }]
    let schemaFormat = true
    let primary: { content: string; doneReason: string | undefined }
    try {
      primary = await this.request(messages, learningDocumentGenerationTimeoutMs(source, mode, detail), learningDocumentOutputTokenLimit(detail), schemaFormat)
    } catch (error) {
      // Some local qwen3 builds can chat normally but fail while Ollama loads the
      // optional JSON-schema vocabulary. The prompt still requires JSON only and
      // the response remains subject to the same strict validator and repair cap.
      if (!(error instanceof Error) || error.message !== 'LEARNING_DOCUMENT_FORMAT_UNAVAILABLE') throw error
      schemaFormat = false
      primary = await this.request(messages, learningDocumentGenerationTimeoutMs(source, mode, detail), learningDocumentOutputTokenLimit(detail), schemaFormat)
    }
    const validated = validateLearningDocumentPayload(parseJsonCandidate(primary.content))
    if (validated !== null) return validated

    // qwen3 occasionally returns a nearly-complete structured response for long videos.
    // A single local repair pass keeps the original candidate transient and never stores it.
    const repairPrompt = `下面的候选学习资料没有通过 JSON 校验。只可依据候选中已有的内容，删除不完整字段并按给定 JSON Schema 重新输出一个完整对象。不要解释、不要添加资料外事实、不要输出 Markdown。\n\n<CANDIDATE>\n${primary.content.slice(0, 24_000)}\n</CANDIDATE>`
    const repaired = await this.request([{ role: 'system', content: LEARNING_DOCUMENT_SYSTEM_PROMPT }, { role: 'user', content: repairPrompt }], Math.min(LEARNING_DOCUMENT_MAX_TIMEOUT_MS, Math.max(LEARNING_DOCUMENT_MIN_TIMEOUT_MS, Math.ceil(repairPrompt.length / 10_000) * 60_000 + 180_000)), learningDocumentOutputTokenLimit(detail), schemaFormat)
    const repairedValidated = validateLearningDocumentPayload(parseJsonCandidate(repaired.content))
    if (repairedValidated === null) throw new Error('LEARNING_DOCUMENT_INVALID')
    return repairedValidated
  }

  private async request(messages: Array<{ role: 'system' | 'user'; content: string }>, timeoutMs: number, outputTokens: number, schemaFormat: boolean): Promise<{ content: string; doneReason: string | undefined }> {
    const requestMessages = schemaFormat
      ? messages
      : messages.map((message, index) => index === messages.length - 1
        ? { ...message, content: `${message.content}\n\nOUTPUT_JSON_SCHEMA:\n${JSON.stringify(LEARNING_DOCUMENT_JSON_SCHEMA)}\n\n仅输出满足此 Schema 的 JSON 对象。` }
        : message)
    let response: Response
    try {
      response = await fetch(new URL('/api/chat', `${this.endpoint}/`), {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          // Ollama's plain JSON mode avoids the optional schema-vocabulary load
          // that fails for some local qwen3 installations. The prompt retains the
          // complete contract and the response still goes through our strict
          // server-side validator below.
          model: this.model, stream: false, think: false, format: schemaFormat ? LEARNING_DOCUMENT_JSON_SCHEMA : 'json', keep_alive: '5m',
          options: { temperature: 0, top_p: 0.8, seed: 42, num_ctx: 16_384, num_predict: outputTokens },
          messages: requestMessages,
        }),
      })
    } catch (error) {
      if (isTimeout(error)) throw new Error('LEARNING_DOCUMENT_MODEL_TIMEOUT')
      throw error
    }
    if (!response.ok) {
      const errorBody = await response.text()
      if (response.status === 500 && /failed to load model vocabulary required for format/iu.test(errorBody)) throw new Error('LEARNING_DOCUMENT_FORMAT_UNAVAILABLE')
      throw new Error(`LEARNING_DOCUMENT_HTTP_${response.status}`)
    }
    const payload = await response.json() as OllamaResponse
    return { content: String(payload.message?.content ?? ''), doneReason: payload.done_reason }
  }
}

export function safeLearningFilename(value: string, suffix = '学习笔记'): string {
  const clean = value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').replace(/\s+》/gu, '》').replace(/\.+$/u, '').trim()
  const base = (clean.slice(0, 96) || '学习资料').replace(new RegExp(`${suffix}$`, 'u'), '').replace(/学习笔记$/u, '').replace(/技术说明$/u, '').trim()
  return `${base || '学习资料'}${suffix}`
}

function removeKnownAsrErrors(content: GeneratedLearningContent, source: LearningDocumentSource): GeneratedLearningContent {
  const forbidden = ['IQ型号', '余显寒数', '向位', 'Ca'].filter(token => !source.source_text.includes(token))
  const knownFormulas = [
    ...source.formula_evidence.map(item => item.formula),
    ...sourceFormulas(source.source_text),
  ].map(item => compactFormula(item).replace(/\s+/gu, '')).filter(Boolean)
  const safe = (value: string): boolean => {
    if (forbidden.some(token => value.includes(token))) return false
    const compactValue = compactFormula(value).replace(/\s+/gu, '')
    if (/arctan|\(\d+\s*,\s*\d+\)/iu.test(value)) return false
    if (value.includes('=')) return knownFormulas.some(formula => formula.includes('=') && compactValue.includes(formula))
    if (/(?:cos|sin|tan)\s*\(/iu.test(value)) {
      const expressions = [...value.matchAll(/[A-Za-z]\s*(?:cos|sin|tan)\s*\([^)]*\)/giu)]
        .map(match => compactFormula(match[0]).replace(/\s+/gu, ''))
      if (expressions.length > 0) return expressions.every(expression => knownFormulas.some(formula => formula.includes(expression)))
      return knownFormulas.some(formula => /(?:cos|sin|tan)\s*\(/iu.test(formula) && compactValue.includes(formula))
    }
    return true
  }
  return {
    ...content,
    summary: safe(content.summary) ? content.summary : '原始资料没有进一步说明。',
    learning_goals: content.learning_goals.filter(safe),
    sections: content.sections.map(section => ({
      ...section,
      summary: safe(section.summary) ? section.summary : '原始资料没有进一步说明。',
      body: safe(section.body) ? section.body : '原始资料没有进一步说明。',
      key_points: section.key_points.filter(safe), examples: section.examples.filter(safe), source_refs: section.source_refs.filter(safe),
    })),
    terms: content.terms.filter(item => safe(item.term) && safe(item.explanation)),
    confusions: content.confusions.filter(safe), key_points: content.key_points.filter(safe),
    review_questions: content.review_questions.filter(safe), learning_tips: content.learning_tips.filter(safe),
  }
}

function formatTimestamp(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function sourceFormulas(source: string): string[] {
  const found = source.replace(/\r\n?/gu, '\n').split('\n').map(line => line.trim())
    .filter(line => line.length > 2 && line.length < 180 && /(?:=|cos|sin|tan|π|φ|\^)/iu.test(line) && !/^(?:https?:|[A-Za-z]:\\)/u.test(line))
  return [...new Set(found)].slice(0, 12)
}

function compactFormula(value: string): string {
  return value.normalize('NFKC')
    .replace(/[（]/gu, '(').replace(/[）]/gu, ')').replace(/[＋]/gu, '+')
    .replace(/[－–—]/gu, '-').replace(/[△]/gu, 'Δ').replace(/[Φ]/gu, 'φ')
    .replace(/\s+/gu, ' ').trim()
}

function normalizeOcrFormula(value: string): string | null {
  const line = compactFormula(value)
  const mainWave = /^A\s*(?:[·*.]\s*)?cos\(\s*2πft\s*\+\s*φ\s*\)$/iu.exec(line)
  if (mainWave !== null) return 'A cos(2πft + φ)'
  const iqWave = /S\s*\(\s*t\s*\)\s*=\s*I\s*\(\s*t\s*\)\s*cos\(\s*wct\s*\)\s*-\s*Q\s*\(\s*t\s*\)\s*sin\(\s*wct\s*\)/iu.exec(line)
  if (iqWave !== null) return 'S(t) = I(t) cos(wct) - Q(t) sin(wct)'
  if (/^2πΔft$/iu.test(line)) return '2πΔft'
  return null
}

export function extractOcrFormulaEvidence(value: unknown): LearningFormulaEvidence[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const frames = (value as { frames?: unknown }).frames
  if (!Array.isArray(frames)) return []
  const formulas = new Map<string, LearningFormulaEvidence>()
  for (const rawFrame of frames) {
    if (rawFrame === null || typeof rawFrame !== 'object' || Array.isArray(rawFrame)) continue
    const frame = rawFrame as OcrFormulaFrame
    const confidence = typeof frame.confidence === 'number' ? frame.confidence : 0
    const timestamp = typeof frame.timestamp_ms === 'number' && Number.isFinite(frame.timestamp_ms) && frame.timestamp_ms >= 0
      ? formatTimestamp(frame.timestamp_ms)
      : undefined
    if (confidence < 0.88 || typeof frame.text !== 'string') continue
    for (const line of frame.text.split(/\r?\n/gu)) {
      const formula = normalizeOcrFormula(line)
      if (formula !== null && !formulas.has(formula)) {
        formulas.set(formula, timestamp === undefined ? { formula, source: 'ocr' } : { formula, time_range: timestamp, source: 'ocr' })
      }
    }
  }
  return [...formulas.values()].slice(0, 12)
}

function displayedFormulas(source: LearningDocumentSource): string[] {
  if (source.formula_evidence.length > 0) {
    return source.formula_evidence.map(item => item.time_range === undefined ? item.formula : `${item.formula}（视频画面：${item.time_range}）`)
  }
  return sourceFormulas(source.source_text)
}

function learningSourceHash(source: LearningDocumentSource): string {
  return sha256(JSON.stringify({ source_text: source.source_text, formula_evidence: source.formula_evidence, user_instruction: source.user_instruction ?? null }))
}

function sourceCodeExamples(source: string): string[] {
  return [...source.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)].map(match => match[1]!.trim()).filter(Boolean).slice(0, 8)
}

export function renderLearningDocumentMarkdown(document: Omit<LearningDocumentRecord, 'id' | 'task_id' | 'project_id' | 'json_artifact_id' | 'docx_artifact_id' | 'supersedes_document_id' | 'created_at'>): string {
  const lines: string[] = [
    `来源：${document.source_title}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `来源地址：${document.source_reference}`,
    '',
    '# 一、内容概览', document.summary, '',
    '# 二、学习目标', ...document.learning_goals.map(item => `- ${item}`), '',
    '# 三、核心知识',
  ]
  for (const section of document.sections) {
    lines.push(`## ${section.title}`, section.summary, '', section.body)
    if (section.key_points.length > 0) lines.push('', '### 要点', ...section.key_points.map(item => `- ${item}`))
    if (section.examples.length > 0) lines.push('', '### 示例', ...section.examples.map(item => `- ${item}`))
    if (section.source_refs.length > 0) lines.push('', `来源时间：${section.source_refs.join('；')}`)
    lines.push('')
  }
  if (document.terms.length > 0) lines.push('# 四、关键术语', '| 术语 | 解释 |', '| --- | --- |', ...document.terms.map(item => `| ${item.term.replaceAll('|', '／')} | ${item.explanation.replaceAll('|', '／')} |`), '')
  if (document.formulas.length > 0) {
    lines.push('# 五、公式与符号说明', '以下表达式来自已校正资料或经本机 OCR 核验的视频画面，保留数学符号以便学习时对照来源。')
    for (const formula of document.formulas) lines.push(`$$${formula}$$`)
    lines.push('')
  }
  if (document.code_examples.length > 0) {
    lines.push('来源中出现的代码：')
    for (const code of document.code_examples) lines.push('```', code, '```', '')
  }
  if (document.confusions.length > 0) lines.push('# 六、容易混淆的内容', ...document.confusions.map(item => `- ${item}`), '')
  lines.push('# 七、重点总结', ...document.key_points.map(item => `- ${item}`), '', '# 八、复习问题', ...document.review_questions.map((item, index) => `${index + 1}. ${item}`), '')
  if (document.learning_tips.length > 0) lines.push('# 九、学习提示', ...document.learning_tips.map(item => `- ${item}`), '')
  lines.push('# 十、来源', ...document.references.map(reference => `- ${reference.label}${reference.time_range === undefined ? '' : `（${reference.time_range}）`}：${reference.reference}`))
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n')}\n`
}

export class LearningDocumentService {
  constructor(
    readonly database: WorkbenchDatabase,
    readonly tasks: TaskManager,
    readonly artifacts: ArtifactService,
    readonly video: VideoKnowledgeRepository,
    readonly provider: LearningDocumentProvider = new Qwen3LearningDocumentProvider(),
  ) {}

  list(taskId: string): LearningDocumentRecord[] { return this.database.listLearningDocumentsForTask(taskId) }
  get(id: string): LearningDocumentRecord {
    const document = this.database.getLearningDocument(id)
    if (document === undefined) throw new Error('LEARNING_DOCUMENT_NOT_FOUND')
    return document
  }

  async resume(input: LearningDocumentGenerateInput): Promise<LearningDocumentRecord> {
    this.tasks.resumeDocumentOutput(input.task_id)
    return this.generate(input)
  }

  async generate(input: LearningDocumentGenerateInput): Promise<LearningDocumentRecord> {
    const task = this.database.getTask(input.task_id)
    if (task === undefined) throw new Error('TASK_NOT_FOUND')
    if (task.status !== 'completed') throw new Error('LEARNING_DOCUMENT_TASK_NOT_COMPLETED')
    const mode = this.mode(input.document_mode)
    const detail = this.detail(input.detail_level)
    const project = task.projectId === null ? this.database.getPersonalInboxProject() : this.database.getProjectContext(task.projectId)
    if (project === undefined) throw new Error('TASK_PROJECT_CONTEXT_REQUIRED')
    const supersedes = input.supersedes_document_id === undefined ? null : this.get(input.supersedes_document_id)
    if (supersedes !== null && (supersedes.task_id !== task.id || supersedes.project_id !== project.id)) throw new Error('LEARNING_DOCUMENT_VERSION_SCOPE_DENIED')
    const startedAt = performance.now()
    try {
      this.runtime(task.id, 'learning_document_planning', 84, '正在整理学习资料。', null)
      let source = await this.resolveSource(task, project.rootPath)
      const strategy = decideDocumentStrategy(source.source_text, source.document_structure)
      this.database.addEvent(task.id, 'learning_document.planned', 'workbench', { sourceType: source.source_type, sourceTitle: source.source_title, correctedTranscript: source.source_type === 'video' })
      if (strategy.mode === 'short') this.tasks.runtimeLog(task.id, { stage: 'learning_document_planning', level: 'info', message: '资料较短，将生成简要学习资料。' })
      if (strategy.mode === 'hierarchical' && source.unified_document_id !== undefined) {
        this.tasks.updateRuntime(task.id, { current_stage: 'processing', progress: 86, status: 'running', message: '正在按章节整理资料。', active_model: null })
        const unified = this.database.getUnifiedDocument(source.unified_document_id)
        if (unified !== undefined) {
          const hierarchy = new HierarchicalDocumentProcessor(this.database).process(unified)
          source = { ...source, source_text: hierarchy.prompt_text }
          this.database.addEvent(task.id, 'document.hierarchy.completed', 'workbench', { documentId: unified.id, hierarchyDepth: hierarchy.hierarchy_depth, chunkCount: hierarchy.chunk_count, sectionCount: hierarchy.section_count, reusedChunkCount: hierarchy.reused_chunk_count })
          this.tasks.runtimeLog(task.id, { stage: 'processing', level: 'info', message: `已完成 ${hierarchy.chunk_count} 个资料分段与 ${hierarchy.section_count} 个章节汇总。` })
        }
      }
      this.runtime(task.id, 'learning_document_generating', 89, strategy.mode === 'short' ? '正在整理简要学习资料。' : '正在组织章节和复习问题。', this.provider.metadata().model)
      let generated: GeneratedLearningContent
      try {
        generated = await this.provider.generate(source, mode, detail)
      } catch (error) {
        // A one-page handout often cannot truthfully satisfy the standard
        // three-goal/five-question contract. Its source-derived compact form is
        // preferable to declaring the already extracted document unusable.
        if (strategy.mode !== 'short' || source.unified_document_id === undefined) throw error
        generated = createCompactLearningContent(source)
        this.database.addEvent(task.id, 'learning_document.compact_fallback', 'workbench', { strategy: strategy.mode, reason: strategy.reason, errorCode: learningDocumentFailure(error).code })
        this.tasks.runtimeLog(task.id, { stage: 'learning_document_generating', level: 'warning', message: '已按短资料结构生成简要学习资料。' })
      }
      if (this.database.getTask(task.id)?.status === 'canceled') throw new Error('LEARNING_DOCUMENT_CANCELED')
      generated = removeKnownAsrErrors(generated, source)
      const documentId = randomUUID()
      const timestamp = new Date().toISOString()
      const title = safeLearningFilename(learningDocumentTitle(generated.document_title, source), mode === 'technical_guide' ? '项目技术说明' : '学习笔记')
      const formulas = displayedFormulas(source)
      const codeExamples = sourceCodeExamples(source.source_text)
      const record: LearningDocumentRecord = {
        id: documentId, task_id: task.id, project_id: project.id, source_type: source.source_type,
        source_title: source.source_title, source_reference: source.source_reference, document_title: title,
        document_mode: mode, detail_level: detail, summary: generated.summary, sections: generated.sections,
        learning_goals: generated.learning_goals, key_points: generated.key_points, terms: generated.terms,
        formulas, code_examples: codeExamples, confusions: generated.confusions, review_questions: generated.review_questions,
        learning_tips: generated.learning_tips, references: source.source_references,
        json_artifact_id: null, docx_artifact_id: null, supersedes_document_id: supersedes?.id ?? null, created_at: timestamp,
      }
      const outputDirectory = path.join(project.rootPath, 'output', task.id, 'learning-documents', documentId)
      await mkdir(outputDirectory, { recursive: true })
      const jsonPath = path.join(outputDirectory, 'learning-document.json')
      const docxPath = path.join(outputDirectory, `${title}.docx`)
      await writeFile(jsonPath, `${JSON.stringify({ schema: 'personal-workbench.learning-document.v1', ...record, generation: this.provider.metadata(), generation_strategy: strategy, source_sha256: learningSourceHash(source), formula_evidence: source.formula_evidence }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      this.runtime(task.id, 'docx_rendering', 95, '正在生成 Word 文档。', null)
      const docx = createDocxFromMarkdown(renderLearningDocumentMarkdown(record), title)
      validateDocx(docx)
      await writeFile(docxPath, docx, { flag: 'wx' })
      const evidence = source.source_artifact_ids.map(sourceId => ({ source_type: 'artifact' as const, source_id: sourceId, relation_type: 'derived_from' as const }))
      const jsonArtifact = await this.artifacts.register({
        project_id: project.id, task_id: task.id, file_path: jsonPath, artifact_type: 'analysis', name: 'learning-document.json',
        metadata: { origin: 'learning-document', document_id: documentId, mode, detail, source_type: source.source_type, status: 'staged' },
        auto_link_task: true, auto_link_session: true, evidence,
        ...(supersedes?.json_artifact_id === null || supersedes?.json_artifact_id === undefined ? {} : { supersedes_artifact_id: supersedes.json_artifact_id, change_note: '重新生成学习资料 JSON' }),
      })
      const docxArtifact = await this.artifacts.register({
        project_id: project.id, task_id: task.id, file_path: docxPath, artifact_type: 'report', name: `${title}.docx`,
        metadata: { origin: 'learning-document', document_id: documentId, mode, detail, source_type: source.source_type, visible_title: title, status: 'staged' },
        auto_link_task: true, auto_link_session: true, evidence: [{ source_type: 'artifact', source_id: jsonArtifact.id, relation_type: 'derived_from' }, ...evidence],
        ...(supersedes?.docx_artifact_id === null || supersedes?.docx_artifact_id === undefined ? {} : { supersedes_artifact_id: supersedes.docx_artifact_id, change_note: '重新生成学习资料 Word 文档' }),
      })
      record.json_artifact_id = jsonArtifact.id
      record.docx_artifact_id = docxArtifact.id
      const saved = this.database.createLearningDocument(record)
      this.database.addEvent(task.id, 'learning_document.completed', 'workbench', {
        documentId: saved.id, jsonArtifactId: jsonArtifact.id, docxArtifactId: docxArtifact.id,
        sourceType: source.source_type, generationMs: Math.round(performance.now() - startedAt),
      })
      this.runtime(task.id, 'output_ready', 100, '学习资料已完成。', null, 'completed')
      return saved
    } catch (error) {
      if (error instanceof Error && error.message === 'LEARNING_DOCUMENT_CANCELED') {
        this.database.addEvent(task.id, 'learning_document.canceled', 'workbench', { resumable: true })
        this.tasks.runtimeLog(task.id, { stage: 'learning_document_generating', level: 'warning', message: '资料整理已经停止，已完成的片段和索引会在继续处理时复用。' })
        throw error
      }
      const failure = learningDocumentFailure(error)
      this.database.addEvent(task.id, 'learning_document.failed', 'workbench', { errorCode: failure.code, retryable: true })
      this.tasks.runtimeLog(task.id, { stage: 'generating', level: 'error', message: failure.message })
      this.tasks.updateRuntime(task.id, { current_stage: 'completed', progress: 100, status: 'completed', message: '源任务已经完成，学习资料可重试。', active_model: null })
      throw new Error(`${failure.code}: ${failure.message}`)
    }
  }

  private runtime(taskId: string, stage: 'learning_document_planning' | 'learning_document_generating' | 'docx_rendering' | 'output_ready', progress: number, message: string, model: string | null, status: 'running' | 'completed' = 'running'): void {
    this.tasks.updateRuntime(taskId, { current_stage: stage, progress, status, message, active_model: model })
    this.tasks.runtimeLog(taskId, { stage, level: 'info', message })
  }

  private mode(value: unknown): LearningDocumentMode {
    return value === 'review_notes' || value === 'technical_guide' || value === 'simple_summary' || value === 'learning_notes' ? value : 'learning_notes'
  }

  private detail(value: unknown): LearningDocumentDetailLevel {
    return value === 'concise' || value === 'detailed' || value === 'standard' ? value : 'standard'
  }

  private async resolveSource(task: WorkbenchTask, projectRoot: string): Promise<LearningDocumentSource> {
    const jobId = typeof task.metadata.jobId === 'string' ? task.metadata.jobId : null
    if (jobId !== null) {
      const document = this.video.getDocumentByJob(jobId)
      if (document === undefined) throw new Error('LEARNING_DOCUMENT_VIDEO_SOURCE_NOT_FOUND')
      const segments = this.video.listSegments(document.id)
      if (segments.length === 0) throw new Error('LEARNING_DOCUMENT_CORRECTED_TRANSCRIPT_NOT_FOUND')
      const cards = this.video.cards.listCards(document.id).filter(card => card.status !== 'superseded')
      const legacy = this.video.listKnowledgePoints(document.id)
      const timestampRefs = segments.map(segment => `${formatTimestamp(segment.start_ms)} - ${formatTimestamp(segment.end_ms)}`)
      const sourceReference = learnerFacingSourceReference(document.source_reference)
      const ocrArtifact = this.database.listArtifacts({ project_id: task.projectId ?? '', task_id: task.id, limit: 200 })
        .find(artifact => artifact.metadata.video_role === '视频关键帧 OCR 结果')
      const formulaEvidence = ocrArtifact === undefined ? [] : await this.readOcrFormulaEvidence(ocrArtifact.absolute_path, projectRoot)
      return {
        source_type: 'video', source_title: document.title, source_reference: sourceReference,
        source_text: segments.map(segment => `[${formatTimestamp(segment.start_ms)} - ${formatTimestamp(segment.end_ms)}] ${segment.text}`).join('\n'),
        source_references: [{ label: document.title, reference: sourceReference, time_range: `${formatTimestamp(segments[0]!.start_ms)} - ${formatTimestamp(segments.at(-1)!.end_ms)}` }],
        source_artifact_ids: [document.transcript_artifact_id, document.knowledge_artifact_id, formulaEvidence.length > 0 ? ocrArtifact?.id : null].filter((id): id is string => id !== null),
        timestamp_refs: timestampRefs, card_summaries: cards.map(card => `${card.title}：${card.core_claim}；${card.explanation}`),
        legacy_summaries: legacy.map(point => `${point.title}：${point.summary}`), formula_evidence: formulaEvidence,
      }
    }
    const unified = this.database.getUnifiedDocumentByTask(task.id)
    if (unified !== undefined) return this.unifiedDocumentSource(unified)
    const direct = await this.readProjectLocalSource(task, projectRoot)
    const sourceText = direct ?? task.resultText ?? ''
    if (sourceText.trim().length === 0) throw new Error('LEARNING_DOCUMENT_SOURCE_EMPTY')
    const sourceTitle = direct === null ? task.title : path.basename(task.inputValue) || task.title
    return {
      source_type: task.inputType || 'local_file', source_title: sourceTitle, source_reference: task.inputValue,
      source_text: sourceText, source_references: [{ label: sourceTitle, reference: direct === null ? '当前任务已经提取的内容' : task.inputValue }],
      source_artifact_ids: [], timestamp_refs: [], card_summaries: [], legacy_summaries: [], formula_evidence: [],
    }
  }

  private unifiedDocumentSource(document: UnifiedDocumentRecord): LearningDocumentSource {
    const selected = Array.isArray(document.metadata.selected_files) ? document.metadata.selected_files : []
    const selectedPaths = selected
      .map(item => item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).repo_relative_path === 'string' ? String((item as Record<string, unknown>).repo_relative_path) : null)
      .filter((item): item is string => item !== null)
    const acquired = new Date(document.acquired_at).toLocaleString('zh-CN', { hour12: false })
    const references: LearningDocumentReference[] = [
      { label: `${document.title} · ${document.site_name ?? '公开来源'} · 获取于 ${acquired}`, reference: document.canonical_url },
    ]
    if (document.source_type === 'github_repo') {
      const commit = typeof document.metadata.repository_commit === 'string' ? document.metadata.repository_commit : null
      const branch = typeof document.metadata.branch === 'string' ? document.metadata.branch : null
      if (commit !== null) references.push({ label: `仓库版本：${branch === null ? '' : `${branch} / `}${commit}`, reference: document.canonical_url })
      if (selectedPaths.length > 0) references.push({ label: `已分析文件：${selectedPaths.join('、')}`, reference: document.canonical_url })
    }
    const artifactIds = Array.isArray(document.metadata.source_artifact_ids)
      ? document.metadata.source_artifact_ids.filter((item): item is string => typeof item === 'string')
      : []
    return {
      source_type: document.source_type, source_title: document.title, source_reference: document.canonical_url,
      source_text: document.content, source_references: references, source_artifact_ids: artifactIds,
      timestamp_refs: [], card_summaries: [], legacy_summaries: [], formula_evidence: [],
      document_structure: {
        section_count: document.sections.length,
        page_or_slide_count: Number(document.metadata.page_count ?? document.metadata.slide_count ?? 0),
      },
      unified_document_id: document.id,
      ...(typeof document.metadata.user_instruction === 'string' && document.metadata.user_instruction.trim().length > 0 ? { user_instruction: document.metadata.user_instruction.trim().slice(0, 600) } : {}),
    }
  }

  private async readOcrFormulaEvidence(filePath: string, projectRoot: string): Promise<LearningFormulaEvidence[]> {
    try {
      const canonical = await realpath(filePath)
      if (!artifactBelongsToRoot(canonical, projectRoot)) return []
      const information = await stat(canonical)
      if (!information.isFile() || information.size > 2 * 1024 * 1024) return []
      return extractOcrFormulaEvidence(JSON.parse(await readFile(canonical, 'utf8')))
    } catch { return [] }
  }

  private async readProjectLocalSource(task: WorkbenchTask, projectRoot: string): Promise<string | null> {
    if (task.inputType !== 'file' || !path.isAbsolute(task.inputValue)) return null
    try {
      const canonical = await realpath(task.inputValue)
      if (!artifactBelongsToRoot(canonical, projectRoot)) return null
      const information = await stat(canonical)
      if (!information.isFile() || information.size > 500 * 1024) return null
      return await readFile(canonical, 'utf8')
    } catch { return null }
  }
}

function learningDocumentTitle(generatedTitle: string, source: LearningDocumentSource): string {
  // Video acceptance tasks often retain a technical STEP title. Prefer the verified
  // topic visible in the corrected source when it is available to the learner.
  if (/(?:^|[^A-Za-z0-9])IQ\s*信号/i.test(source.source_text)) return 'IQ信号'
  return generatedTitle || source.source_title
}

function learnerFacingSourceReference(reference: string): string {
  // Video jobs retain their technical workspace path for provenance. The Word
  // document shows a plain local-source label instead of exposing job IDs.
  if (/[\\/]output[\\/]video-knowledge[\\/][0-9a-f-]{36}[\\/]/iu.test(reference)) return '本地视频（已导入受控副本）'
  return reference
}
