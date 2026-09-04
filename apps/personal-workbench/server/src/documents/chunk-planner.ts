import type { UnifiedDocumentSection } from '../../../shared/contracts/index.ts'

export interface DocumentChunk {
  index: number
  anchors: string[]
  text: string
  char_count: number
}

/**
 * Deterministic, source-preserving planning used before a local model receives a
 * long document. The planner never summarizes or invents content; it only keeps
 * section/page/slide/sheet boundaries and caps one model input at a fixed size.
 */
export function planDocumentChunks(sections: UnifiedDocumentSection[], maximumChars = 12_000): DocumentChunk[] {
  const limit = Math.max(1_000, Math.min(32_000, Math.trunc(maximumChars)))
  const chunks: DocumentChunk[] = []
  let anchors: string[] = []; let parts: string[] = []; let size = 0
  const flush = (): void => {
    if (parts.length === 0) return
    const text = parts.join('\n\n').trim()
    chunks.push({ index: chunks.length + 1, anchors, text, char_count: text.length })
    anchors = []; parts = []; size = 0
  }
  for (const section of sections) {
    const block = `# ${section.heading}\n\n${section.text}`.trim()
    if (block.length <= limit) {
      if (size > 0 && size + block.length + 2 > limit) flush()
      parts.push(block); anchors.push(section.source_anchor); size += block.length + 2
      continue
    }
    flush()
    for (let offset = 0; offset < block.length; offset += limit) {
      const text = block.slice(offset, offset + limit)
      chunks.push({ index: chunks.length + 1, anchors: [`${section.source_anchor}${block.length > limit ? `#part-${Math.floor(offset / limit) + 1}` : ''}`], text, char_count: text.length })
    }
  }
  flush()
  return chunks
}
