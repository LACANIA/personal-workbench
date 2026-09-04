import type { DetectedKnowledgeSource, KnowledgeSourceAdapterHealth, UnifiedDocumentRecord } from '../../../shared/contracts/index.ts'

export class SourceAdapterError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    readonly status = 400,
  ) {
    super(code)
  }
}

export interface AdapterRuntime {
  stage: 'fetching' | 'processing' | 'extracting'
  progress: number
  message: string
  tool?: string
  level?: 'info' | 'warning'
}

export interface SourceAdapterContext {
  taskId: string
  projectId: string
  report(runtime: AdapterRuntime): void
}

/**
 * All remote-source implementations use the same narrow interface. An adapter
 * may inspect or acquire only the URL the user submitted; it never receives a
 * browser profile, cookie jar, command string, or source code to execute.
 */
export interface KnowledgeSourceAdapter {
  readonly id: 'video' | 'web' | 'github' | 'document'
  canHandle(source: DetectedKnowledgeSource): boolean
  inspect(source: DetectedKnowledgeSource): Promise<Record<string, unknown>>
  acquire(source: DetectedKnowledgeSource, context: SourceAdapterContext): Promise<UnifiedDocumentRecord>
  normalize(document: UnifiedDocumentRecord): UnifiedDocumentRecord
  toUnifiedDocument(document: UnifiedDocumentRecord): UnifiedDocumentRecord
  health(): Promise<KnowledgeSourceAdapterHealth>
}
