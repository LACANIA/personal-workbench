import { createHash } from 'node:crypto'

export interface SubtitleCue {
  startMs: number
  endMs: number
  text: string
}

export interface ParsedSubtitle {
  format: 'srt' | 'vtt' | 'text'
  cues: SubtitleCue[]
  language: string
  durationMs: number
}

export interface KnowledgeSegment {
  index: number
  startMs: number
  endMs: number
  text: string
  textHash: string
}

function timestamp(value: string): number {
  const match = value.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})$/u)
  if (match === null) throw new Error('INVALID_SUBTITLE_TIMESTAMP')
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4])
}

function normalize(value: string): string {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
}

function validCue(cue: SubtitleCue): SubtitleCue {
  const text = cue.text.replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim()
  if (text.length === 0 || text.length > 20_000 || cue.startMs < 0 || cue.endMs < cue.startMs) throw new Error('INVALID_SUBTITLE_CUE')
  return { ...cue, text }
}

function parseTimedBlock(block: string, isVtt: boolean): SubtitleCue | null {
  const rows = block.split('\n').map(row => row.trimEnd())
  const timingIndex = rows.findIndex(row => row.includes('-->'))
  if (timingIndex < 0) return null
  const [left, rightWithSettings] = rows[timingIndex]!.split('-->', 2).map(value => value.trim())
  if (left === undefined || rightWithSettings === undefined) return null
  const right = rightWithSettings.split(/\s+/u, 1)[0]!
  const normalizeTimestamp = (value: string): string => isVtt && /^\d{2}:\d{2}[.]/u.test(value) ? `00:${value}` : value
  return validCue({
    startMs: timestamp(normalizeTimestamp(left)),
    endMs: timestamp(normalizeTimestamp(right)),
    text: rows.slice(timingIndex + 1).join('\n'),
  })
}

export function parseSubtitle(raw: string, extension: string, language = 'auto'): ParsedSubtitle {
  if (typeof raw !== 'string' || raw.includes('\0') || Buffer.byteLength(raw, 'utf8') > 5 * 1024 * 1024) throw new Error('INVALID_SUBTITLE_CONTENT')
  const text = normalize(raw)
  const ext = extension.toLowerCase()
  let format: ParsedSubtitle['format']
  let cues: SubtitleCue[]
  if (ext === '.srt') {
    format = 'srt'
    cues = text.split(/\n{2,}/u).map(block => parseTimedBlock(block, false)).filter((cue): cue is SubtitleCue => cue !== null)
  } else if (ext === '.vtt') {
    format = 'vtt'
    cues = text.replace(/^WEBVTT[^\n]*\n/u, '').split(/\n{2,}/u).map(block => parseTimedBlock(block, true)).filter((cue): cue is SubtitleCue => cue !== null)
  } else if (ext === '.txt') {
    format = 'text'
    const blocks = text.split(/\n{2,}/u).map(item => item.trim()).filter(Boolean)
    cues = blocks.map((value, index) => validCue({ startMs: index * 8_000, endMs: (index + 1) * 8_000, text: value }))
  } else {
    throw new Error('UNSUPPORTED_SUBTITLE_EXTENSION')
  }
  if (cues.length === 0) throw new Error('SUBTITLE_EMPTY')
  cues.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  return { format, cues, language, durationMs: cues[cues.length - 1]!.endMs }
}

export function segmentSubtitle(parsed: ParsedSubtitle, options: { maxChars?: number; maxDurationMs?: number } = {}): KnowledgeSegment[] {
  const maxChars = options.maxChars ?? 1200
  const maxDurationMs = options.maxDurationMs ?? 120_000
  if (maxChars < 100 || maxChars > 8000 || maxDurationMs < 10_000 || maxDurationMs > 600_000) throw new Error('INVALID_SEGMENT_CONFIG')
  const groups: SubtitleCue[][] = []
  let current: SubtitleCue[] = []
  let chars = 0
  for (const cue of parsed.cues) {
    const first = current[0]
    const wouldOverflow = current.length > 0 && (chars + cue.text.length + 1 > maxChars || (first !== undefined && cue.endMs - first.startMs > maxDurationMs))
    if (wouldOverflow) { groups.push(current); current = []; chars = 0 }
    current.push(cue)
    chars += cue.text.length + 1
  }
  if (current.length > 0) groups.push(current)
  return groups.map((group, index) => {
    const text = group.map(cue => cue.text).join('\n').trim()
    return {
      index,
      startMs: group[0]!.startMs,
      endMs: group[group.length - 1]!.endMs,
      text,
      textHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    }
  })
}

export function renderTranscript(title: string, segments: KnowledgeSegment[]): string {
  const lines = [`# ${title}`, '', '> Personal Workbench 本地视频知识任务生成的时间轴文本。', '']
  for (const segment of segments) {
    const seconds = (segment.startMs / 1000).toFixed(3)
    lines.push(`## ${seconds}s`, '', segment.text, '')
  }
  return `${lines.join('\n')}\n`
}

function srtTimestamp(value: number): string {
  const milliseconds = Math.max(0, Math.trunc(value))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  const remainder = milliseconds % 1_000
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${remainder.toString().padStart(3, '0')}`
}

/** 将校正后的 cue 保留为可审计 SRT；原始字幕会另行保留，不会被覆盖。 */
export function renderSrt(parsed: ParsedSubtitle): string {
  return `${parsed.cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${cue.text}`).join('\n\n')}\n`
}
