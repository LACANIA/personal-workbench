import type { DetectedKnowledgeSource, KnowledgeSourceAdapterHealth } from '../../../shared/contracts/index.ts'
import { GitHubSourceAdapter } from './github-source-adapter.ts'
import { DocumentSourceAdapter } from './document-source-adapter.ts'
import type { KnowledgeSourceAdapter } from './types.ts'
import { VideoSourceAdapter } from './video-source-adapter.ts'
import { WebSourceAdapter } from './web-source-adapter.ts'

export class SourceAdapterRegistry {
  readonly adapters: KnowledgeSourceAdapter[]

  constructor(adapters: KnowledgeSourceAdapter[] = [new VideoSourceAdapter(), new GitHubSourceAdapter(), new WebSourceAdapter(), new DocumentSourceAdapter()]) {
    this.adapters = adapters
  }

  forSource(source: DetectedKnowledgeSource): KnowledgeSourceAdapter | undefined {
    return this.adapters.find(adapter => adapter.canHandle(source))
  }

  async health(): Promise<KnowledgeSourceAdapterHealth[]> { return Promise.all(this.adapters.map(adapter => adapter.health())) }
}
