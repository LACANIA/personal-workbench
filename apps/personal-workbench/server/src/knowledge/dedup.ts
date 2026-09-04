import type { KnowledgeCardRecord } from '../../../shared/contracts/index.ts'
import { cosineSimilarity, type EmbeddingProvider } from '../video/embedding.ts'

export const KNOWLEDGE_CARD_DUPLICATE_THRESHOLD = 0.92

export interface DuplicateDecision {
  status: KnowledgeCardRecord['duplicate_status']
  duplicate_of_card_id: string | null
  similarity: number | null
}

export class KnowledgeDedupService {
  constructor(
    readonly provider: EmbeddingProvider,
    readonly threshold = KNOWLEDGE_CARD_DUPLICATE_THRESHOLD,
  ) {}

  async compare(card: KnowledgeCardRecord, candidates: KnowledgeCardRecord[]): Promise<DuplicateDecision> {
    const exact = candidates.find(candidate => candidate.id !== card.id && candidate.segment_id !== card.segment_id && candidate.source_sha256 === card.source_sha256)
    if (exact !== undefined) return { status: 'same_source_duplicate', duplicate_of_card_id: exact.id, similarity: 1 }
    const eligible = candidates.filter(candidate => candidate.id !== card.id && candidate.source_state === 'current' && candidate.status !== 'rejected')
    if (eligible.length === 0) return { status: 'unique', duplicate_of_card_id: null, similarity: null }
    const [query, ...vectors] = await this.provider.embedBatch([cardEmbeddingText(card), ...eligible.map(cardEmbeddingText)])
    let selectedCard: KnowledgeCardRecord | null = null
    let selectedScore = Number.NEGATIVE_INFINITY
    for (let index = 0; index < vectors.length; index += 1) {
      const vector = vectors[index]!
      const score = cosineSimilarity(query!.vector, vector.vector)
      if (score > selectedScore || (score === selectedScore && (selectedCard === null || eligible[index]!.id.localeCompare(selectedCard.id) < 0))) {
        selectedCard = eligible[index]!
        selectedScore = score
      }
    }
    if (selectedCard === null || selectedScore < this.threshold) return { status: 'unique', duplicate_of_card_id: null, similarity: selectedCard === null ? null : selectedScore }
    return { status: 'possible_duplicate', duplicate_of_card_id: selectedCard.id, similarity: selectedScore }
  }
}

export function cardEmbeddingText(card: Pick<KnowledgeCardRecord, 'title' | 'concept' | 'core_claim' | 'explanation' | 'keywords'>): string {
  return [card.title, card.concept, card.core_claim, card.explanation, card.keywords.join(', ')].join('\n')
}
