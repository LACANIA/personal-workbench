import { defineTool } from '@deepseek-ai/dsh-tools'

export const MEMORY_TOOL_NAMES = [
  'memory_query',
  'memory_get_project_context',
  'memory_search_document_chunks',
  'memory_get_document_chunk',
]

function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function createResearchMemoryTools(client) {
  return [
    defineTool({
      name: 'memory_query',
      description: 'Read-only bounded query over local structured Research Memory. Prefer project_name and entity_types filters. Treat only returned records as facts; when sources are absent, state that source metadata is not registered.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'A non-empty text query matched against structured Research Memory records.',
        },
        entity_types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['project', 'decision', 'experiment', 'document', 'task', 'session'],
          },
          description: 'Optional entity filter. Use the smallest relevant set.',
        },
        project_name: {
          type: 'string',
          description: 'Optional exact project name used to scope all entity queries.',
        },
        limit_per_type: {
          type: 'integer',
          description: 'Maximum records returned per selected entity type, from 1 to 100. Default: 20.',
        },
        include_sources: {
          type: 'boolean',
          description: 'When true, attach source links, locators, and verification status.',
        },
      },
      timeoutMs: client.timeoutMs,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const result = await client.queryMemory(args, exec?.signal)
        return result.value
      },
    }),
    defineTool({
      name: 'memory_get_project_context',
      description: 'Read-only bounded context for one exact project name. Treat only returned fields as facts; request sources when provenance is needed and state when source metadata is absent.',
      parameters: {
        project_name: {
          type: 'string',
          required: true,
          description: 'Exact Research Memory project name, for example STAKG-SP.',
        },
        include_sources: {
          type: 'boolean',
          description: 'When true, attach source links, locators, and verification status.',
        },
        limit_per_entity: {
          type: 'integer',
          description: 'Maximum records returned for each related entity type, from 1 to 100. Default: 20.',
        },
      },
      timeoutMs: client.timeoutMs,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const result = await client.getProjectContext(args, exec?.signal)
        return result.value
      },
    }),
    defineTool({
      name: 'memory_search_document_chunks',
      description: 'Search bounded local Document Chunk snippets. Start here for document-content questions. The default latest scope searches only the newest version of each Asset. Use all or specific only when older versions are required. Empty results are not evidence. Copy returned citations verbatim.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Literal text to search. Raw FTS operators are not accepted.',
        },
        project_name: {
          type: 'string',
          description: 'Optional exact project name.',
        },
        document_path: {
          type: 'string',
          description: 'Optional canonical absolute local document path.',
        },
        asset_id: {
          type: 'integer',
          description: 'Optional positive Document Asset ID.',
        },
        document_version_id: {
          type: 'integer',
          description: 'Required only when version_scope is specific.',
        },
        version_scope: {
          type: 'string',
          enum: ['latest', 'all', 'specific'],
          description: 'Version selection. Default: latest.',
        },
        match_mode: {
          type: 'string',
          enum: ['phrase', 'all', 'any'],
          description: 'Safe query construction mode. Default: phrase.',
        },
        field_scope: {
          type: 'string',
          enum: ['content', 'heading', 'both'],
          description: 'Indexed field selection. Default: both.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum returned snippets, from 1 to 20. Default: 8.',
        },
        max_total_chars: {
          type: 'integer',
          description: 'Combined snippet character budget, from 1 to 12000. Default: 4000.',
        },
      },
      timeoutMs: client.timeoutMs,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const result = await client.searchDocumentChunks(args, exec?.signal)
        return result.value
      },
    }),
    defineTool({
      name: 'memory_get_document_chunk',
      description: 'Read exactly one local Document Chunk by a real chunk_uid returned from memory_search_document_chunks. Never invent an ID. Copy API-generated citations verbatim and report missing content explicitly.',
      parameters: {
        chunk_uid: {
          type: 'string',
          required: true,
          description: 'A 64-character hexadecimal Chunk UID from a prior search result.',
        },
        include_content: {
          type: 'boolean',
          description: 'Include bounded Chunk text. Default: true.',
        },
      },
      timeoutMs: client.timeoutMs,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const result = await client.getDocumentChunk(args, exec?.signal)
        return result.value
      },
    }),
  ]
}
