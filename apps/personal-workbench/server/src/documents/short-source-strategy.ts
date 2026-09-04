import type { LearningDocumentReference } from '../../../shared/contracts/index.ts'
import type { GeneratedLearningContent, LearningDocumentSource } from '../learning/service.ts'

export type DocumentProcessingStrategy = 'short' | 'standard' | 'hierarchical'

export interface SourceStructureHint {
  section_count: number
  page_or_slide_count: number
}

export interface SourceStrategyDecision {
  mode: DocumentProcessingStrategy
  reason: 'compact_content' | 'normal_content' | 'large_or_structured_content'
  character_count: number
  section_count: number
  page_or_slide_count: number
}

/**
 * Chooses a presentation strategy from extracted content, never from file size.
 * The cut-offs deliberately leave ordinary lecture notes in the standard path.
 */
export function decideDocumentStrategy(text: string, hint: Partial<SourceStructureHint> = {}): SourceStrategyDecision {
  const characterCount = text.replace(/\s+/gu, '').length
  const sectionCount = Math.max(0, Math.floor(hint.section_count ?? 0))
  const pageOrSlideCount = Math.max(0, Math.floor(hint.page_or_slide_count ?? 0))
  if (characterCount <= 1_800 && sectionCount <= 2 && pageOrSlideCount <= 2) {
    return { mode: 'short', reason: 'compact_content', character_count: characterCount, section_count: sectionCount, page_or_slide_count: pageOrSlideCount }
  }
  if (characterCount > 28_000 || sectionCount >= 8 || pageOrSlideCount >= 20) {
    return { mode: 'hierarchical', reason: 'large_or_structured_content', character_count: characterCount, section_count: sectionCount, page_or_slide_count: pageOrSlideCount }
  }
  return { mode: 'standard', reason: 'normal_content', character_count: characterCount, section_count: sectionCount, page_or_slide_count: pageOrSlideCount }
}

function sentences(text: string): string[] {
  return text
    .replace(/^#{1,6}\s+/gmu, '')
    .split(/(?<=[。！？.!?])\s*|\n+/u)
    .map(item => item.replace(/\s+/gu, ' ').trim())
    .filter(item => item.length >= 4)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 8)
}

function visibleReference(references: LearningDocumentReference[]): string[] {
  return references.map(item => item.time_range ?? item.label).filter(Boolean).slice(0, 4)
}

/**
 * A compact document is intentionally deterministic and source-grounded. It is
 * used only when a short source cannot meet the full Qwen JSON contract; the
 * normal Word renderer still consumes the usual GeneratedLearningContent shape.
 */
export function createCompactLearningContent(source: LearningDocumentSource): GeneratedLearningContent {
  const points = sentences(source.source_text)
  const sourceRefs = visibleReference(source.source_references)
  const title = source.source_title.replace(/[《》]/gu, '').trim().slice(0, 80) || '简要学习资料'
  const summary = points[0] ?? '原始资料内容较短，已整理为简要学习资料。'
  const keyPoints = points.length > 0 ? points.slice(0, 5) : ['原始资料没有进一步说明。']
  const sectionBody = points.join('\n') || '原始资料没有进一步说明。'
  return {
    document_title: title,
    summary,
    learning_goals: [
      `了解资料“${title}”的主要内容。`,
      '能够回到来源位置复核原始表述。',
      '根据资料中的重点完成一次简要复习。',
    ],
    sections: [{
      title: '核心内容', summary, body: sectionBody,
      key_points: keyPoints, examples: [], source_refs: sourceRefs,
    }],
    terms: [],
    confusions: [],
    key_points: keyPoints,
    review_questions: points.slice(0, 3).map(item => `资料中如何说明“${item.slice(0, 48)}”？`),
    learning_tips: ['资料内容较短，建议结合来源原文复习。'],
  }
}
