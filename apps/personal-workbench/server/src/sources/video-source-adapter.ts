import type { DetectedKnowledgeSource, KnowledgeSourceAdapterHealth, UnifiedDocumentRecord } from '../../../shared/contracts/index.ts'
import type { KnowledgeSourceAdapter, SourceAdapterContext } from './types.ts'

/**
 * The media pipeline remains owned by VideoKnowledgeService. This adapter only
 * makes that existing route visible to the common source-adapter registry.
 */
export class VideoSourceAdapter implements KnowledgeSourceAdapter {
  readonly id = 'video' as const
  canHandle(source: DetectedKnowledgeSource): boolean { return source.source_type === 'video_url' }
  async inspect(source: DetectedKnowledgeSource): Promise<Record<string, unknown>> { return { adapter: this.id, source_type: source.source_type, delegated: 'VideoKnowledgeService' } }
  async acquire(): Promise<UnifiedDocumentRecord> { throw new Error('VIDEO_ADAPTER_DELEGATES_TO_EXISTING_PIPELINE') }
  normalize(document: UnifiedDocumentRecord): UnifiedDocumentRecord { return document }
  toUnifiedDocument(document: UnifiedDocumentRecord): UnifiedDocumentRecord { return document }
  async health(): Promise<KnowledgeSourceAdapterHealth> { return { id: this.id, available: true, detail: '复用现有 Video Knowledge 本机流水线' } }
}
