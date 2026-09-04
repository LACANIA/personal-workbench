import { createHash, randomUUID } from 'node:crypto'
import type { UnifiedDocumentRecord } from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { planDocumentChunks, type DocumentChunk } from './chunk-planner.ts'

export interface ChunkSummary {
  chunk_index: number
  topic: string
  summary: string
  key_points: string[]
  terms: string[]
  source_anchors: string[]
}

export interface SectionSummary {
  section_index: number
  section_title: string
  overview: string
  key_points: string[]
  important_terms: string[]
  source_range: string
}

export interface HierarchicalDocumentResult {
  hierarchy_depth: 2
  chunk_count: number
  section_count: number
  reused_chunk_count: number
  chunk_summaries: ChunkSummary[]
  section_summaries: SectionSummary[]
  document_summary: string
  prompt_text: string
}

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function clean(value: string, maximum: number): string { return value.replace(/\s+/gu, ' ').trim().slice(0, maximum) }
function fragments(value: string, maximum = 4): string[] {
  return value.split(/(?<=[。！？.!?])\s*|\n+/u).map(item => clean(item, 260)).filter(item => item.length >= 8).slice(0, maximum)
}
function likelyTerms(value: string): string[] {
  const found = value.match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,12}/gu) ?? []
  return [...new Set(found.filter(item => item.length >= 2 && !/^(?:本文|资料|内容|进行|可以|以及|一个)$/u.test(item)))].slice(0, 8)
}
function sectionTitleFor(document: UnifiedDocumentRecord, chunk: DocumentChunk): string {
  const anchor = chunk.anchors[0] ?? ''
  const section = document.sections.find(item => item.source_anchor === anchor || anchor.startsWith(`${item.source_anchor}#`))
  return clean(section?.heading ?? document.title, 100)
}
function parseJsonList(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : [] } catch { return [] }
}

/**
 * Builds a resumable, source-anchored hierarchy. The summaries are deliberately
 * extractive: qwen3 only receives this bounded, traceable hierarchy in the
 * final learning-document pass, so a large original document is never sent as
 * a single prompt.
 */
export class HierarchicalDocumentProcessor {
  constructor(readonly database: WorkbenchDatabase) {}

  process(document: UnifiedDocumentRecord): HierarchicalDocumentResult {
    const chunks = planDocumentChunks(document.sections)
    const existing = this.database.db.prepare(`
      SELECT chunk_index, topic, summary, key_points_json, terms_json, source_anchors_json
      FROM document_chunk_summaries WHERE document_id=? AND content_sha256=? AND status='completed'
    `).all(document.id, document.content_sha256) as Array<Record<string, unknown>>
    const byIndex = new Map(existing.map(row => [Number(row.chunk_index), row]))
    const summaries: ChunkSummary[] = []
    let reused = 0
    for (const chunk of chunks) {
      const stored = byIndex.get(chunk.index)
      if (stored !== undefined) {
        reused += 1
        summaries.push({ chunk_index: chunk.index, topic: String(stored.topic), summary: String(stored.summary), key_points: parseJsonList(stored.key_points_json), terms: parseJsonList(stored.terms_json), source_anchors: parseJsonList(stored.source_anchors_json) })
        continue
      }
      const points = fragments(chunk.text)
      const summary: ChunkSummary = {
        chunk_index: chunk.index,
        topic: sectionTitleFor(document, chunk),
        summary: points.join(' ') || clean(chunk.text, 900),
        key_points: points,
        terms: likelyTerms(chunk.text),
        source_anchors: chunk.anchors,
      }
      this.database.db.prepare(`
        INSERT INTO document_chunk_summaries(id,document_id,content_sha256,chunk_index,topic,summary,key_points_json,terms_json,source_anchors_json,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'completed',?)
        ON CONFLICT(document_id,content_sha256,chunk_index) DO UPDATE SET topic=excluded.topic,summary=excluded.summary,key_points_json=excluded.key_points_json,terms_json=excluded.terms_json,source_anchors_json=excluded.source_anchors_json,status='completed',created_at=excluded.created_at
      `).run(randomUUID(), document.id, document.content_sha256, summary.chunk_index, summary.topic, summary.summary, JSON.stringify(summary.key_points), JSON.stringify(summary.terms), JSON.stringify(summary.source_anchors), new Date().toISOString())
      summaries.push(summary)
    }
    const grouped = new Map<string, ChunkSummary[]>()
    for (const summary of summaries) grouped.set(summary.topic, [...(grouped.get(summary.topic) ?? []), summary])
    const sections: SectionSummary[] = [...grouped.entries()].map(([title, entries], index) => {
      const points = [...new Set(entries.flatMap(item => item.key_points))].slice(0, 8)
      const terms = [...new Set(entries.flatMap(item => item.terms))].slice(0, 12)
      const anchors = entries.flatMap(item => item.source_anchors)
      return { section_index: index + 1, section_title: title, overview: clean(entries.map(item => item.summary).join(' '), 1_500), key_points: points, important_terms: terms, source_range: anchors.join('、') }
    })
    for (const section of sections) this.database.db.prepare(`
      INSERT INTO document_section_summaries(id,document_id,content_sha256,section_index,section_title,overview,key_points_json,important_terms_json,source_range,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(document_id,content_sha256,section_index) DO UPDATE SET section_title=excluded.section_title,overview=excluded.overview,key_points_json=excluded.key_points_json,important_terms_json=excluded.important_terms_json,source_range=excluded.source_range,created_at=excluded.created_at
    `).run(randomUUID(), document.id, document.content_sha256, section.section_index, section.section_title, section.overview, JSON.stringify(section.key_points), JSON.stringify(section.important_terms), section.source_range, new Date().toISOString())
    const documentSummary = clean(sections.map(section => `${section.section_title}：${section.overview}`).join('\n'), 18_000)
    const promptText = sections.map(section => `[${section.source_range}] ${section.section_title}\n${section.overview}\n重点：${section.key_points.join('；')}`).join('\n\n').slice(0, 24_000)
    return { hierarchy_depth: 2, chunk_count: chunks.length, section_count: sections.length, reused_chunk_count: reused, chunk_summaries: summaries, section_summaries: sections, document_summary: documentSummary, prompt_text: promptText }
  }
}
