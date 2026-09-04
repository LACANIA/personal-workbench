import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PATHS } from '../config.ts'
import type { ParsedSubtitle, SubtitleCue } from './subtitle.ts'

export interface DomainTerm {
  canonical: string
  aliases: string[]
  domain: string
}

export interface OcrTextEvidence {
  index: number
  timestamp_ms: number
  text: string
  confidence?: number | null
}

export interface TranscriptCorrectionChange {
  cue_index: number
  timestamp_ms: number
  from: string
  to: string
  canonical: string
  source: 'ocr' | 'dictionary'
}

export interface TranscriptCorrectionResult {
  parsed: ParsedSubtitle
  transcript_source: 'asr_ocr_fusion' | 'domain_dictionary'
  dictionary_version: string
  ocr_frame_count: number
  changes: TranscriptCorrectionChange[]
  original_sha256: string
  corrected_sha256: string
}

interface DictionaryFile {
  schema: string
  version: string
  domains: Record<string, Array<{ canonical: string; aliases: string[] }>>
}

function compact(value: string): string { return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN') }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

function replaceAlias(text: string, alias: string, canonical: string): { text: string; count: number } {
  if (alias === canonical) return { text, count: 0 }
  const ascii = /^[A-Za-z0-9._+-]+$/u.test(alias)
  const expression = ascii
    ? new RegExp(`(?<![A-Za-z])${escapeRegExp(alias)}(?![A-Za-z])`, 'giu')
    : new RegExp(escapeRegExp(alias), 'gu')
  let count = 0
  const corrected = text.replace(expression, () => { count += 1; return canonical })
  return { text: corrected, count }
}

function flatten(dictionary: DictionaryFile): DomainTerm[] {
  const terms: DomainTerm[] = []
  for (const [domain, entries] of Object.entries(dictionary.domains)) {
    for (const entry of entries) {
      if (typeof entry.canonical !== 'string' || entry.canonical.length === 0 || !Array.isArray(entry.aliases)) continue
      terms.push({ canonical: entry.canonical, aliases: [...new Set([entry.canonical, ...entry.aliases].filter(value => typeof value === 'string' && value.length > 0))], domain })
    }
  }
  return terms
}

/**
 * 只在受控词典中替换已知 ASR 混淆词。OCR 提供的术语优先启用对应规范词，
 * 没有视频帧时仍可用词典校正已知混淆，且不会凭空插入 OCR 中不存在的句子。
 */
export class TranscriptCorrectionService {
  private cached: Promise<{ version: string; terms: DomainTerm[] }> | null = null

  constructor(readonly dictionaryPath = path.join(PATHS.appRoot, 'server', 'src', 'video', 'domain_dictionary.json')) {}

  async dictionary(): Promise<{ version: string; terms: DomainTerm[] }> {
    if (this.cached !== null) return this.cached
    this.cached = (async () => {
      const raw = await readFile(this.dictionaryPath, 'utf8')
      const value = JSON.parse(raw) as DictionaryFile
      if (value.schema !== 'personal-workbench.domain-dictionary.v1' || typeof value.version !== 'string' || value.domains === null || typeof value.domains !== 'object') {
        throw new Error('DOMAIN_DICTIONARY_INVALID')
      }
      const terms = flatten(value)
      if (terms.length === 0) throw new Error('DOMAIN_DICTIONARY_EMPTY')
      return { version: value.version, terms }
    })()
    return this.cached
  }

  async correct(parsed: ParsedSubtitle, ocrFrames: OcrTextEvidence[]): Promise<TranscriptCorrectionResult> {
    const dictionary = await this.dictionary()
    const ocrText = ocrFrames.map(frame => frame.text).join('\n')
    const normalizedOcr = compact(ocrText)
    const enabledByOcr = new Set(dictionary.terms.filter(term => term.aliases.some(alias => normalizedOcr.includes(compact(alias)))).map(term => term.canonical))
    const changes: TranscriptCorrectionChange[] = []
    const cues: SubtitleCue[] = parsed.cues.map((cue, cueIndex) => {
      const original = cue.text
      let current = original
      for (const term of dictionary.terms) {
        const source: TranscriptCorrectionChange['source'] = enabledByOcr.has(term.canonical) ? 'ocr' : 'dictionary'
        for (const alias of term.aliases.filter(alias => alias !== term.canonical)) {
          const result = replaceAlias(current, alias, term.canonical)
          if (result.count > 0) {
            changes.push({ cue_index: cueIndex, timestamp_ms: cue.startMs, from: alias, to: term.canonical, canonical: term.canonical, source })
            current = result.text
          }
        }
      }
      return current === original ? cue : { ...cue, text: current }
    })
    const originalText = parsed.cues.map(cue => cue.text).join('\n')
    const correctedText = cues.map(cue => cue.text).join('\n')
    return {
      parsed: { ...parsed, cues }, transcript_source: ocrFrames.length > 0 ? 'asr_ocr_fusion' : 'domain_dictionary',
      dictionary_version: dictionary.version, ocr_frame_count: ocrFrames.length, changes,
      original_sha256: sha256(originalText), corrected_sha256: sha256(correctedText),
    }
  }
}
