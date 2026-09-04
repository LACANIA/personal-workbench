import { ResearchMemoryClient } from './client.js'
import { createResearchMemoryTools } from './tools.js'

export const name = 'research-memory'
export const inject = ['tools', 'systemPrompt']

export async function apply(ctx, config = {}) {
  const client = await ResearchMemoryClient.create(config)
  const citationPolicy = typeof config.citationPolicy === 'string'
    ? config.citationPolicy.trim()
    : ''

  ctx.systemPrompt.section({
    name: 'tool:research-memory',
    order: 110,
    text: [
      'Use memory_query for bounded structured evidence and memory_get_project_context for a bounded named-project summary. For document-content questions, call memory_search_document_chunks first. Search snippets are candidate evidence; call memory_get_document_chunk with a real returned chunk_uid when fuller context is needed. The default version scope is latest. Never invent a Memory ID, Source ID, Version ID, or Chunk UID. Empty search results mean the Document Chunk index has no matching content. Treat only tool-result fields as facts and copy memory_citation, source_citation, source_citations, and chunk_citation verbatim. A source belongs only to the record whose own sources array contains it; never transfer a source or locator between records. Research Memory tools are read-only.',
      citationPolicy,
    ].filter(Boolean).join(' '),
  })

  for (const tool of createResearchMemoryTools(client)) {
    ctx.tools.register(tool)
  }
}
