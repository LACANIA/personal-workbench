import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { MemoryClientError, ResearchMemoryClient } from '../plugins/research-memory/src/client.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const databasePath = path.join(repoRoot, 'memory', 'tests', 'test_research_memory.db')
const pythonExecutable = process.env.PYTHON_EXECUTABLE ?? execFileSync(
  process.platform === 'win32' ? 'where.exe' : 'which',
  ['python'],
  { encoding: 'utf8' },
).split(/\r?\n/u).find(Boolean)
const config = {
  pythonExecutable,
  bridgePath: path.join(repoRoot, 'memory', 'api', 'read_only_bridge.py'),
  databasePath,
  timeoutMs: 15000,
}

async function databaseEvidence() {
  const [content, info] = await Promise.all([readFile(databasePath), stat(databasePath)])
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    size: info.size,
    mtimeMs: info.mtimeMs,
  }
}

test('read-only client returns Decision and Experiment matches', async () => {
  const client = await ResearchMemoryClient.create(config)
  const result = await client.queryMemory({
    query: '0.0136%',
    entity_types: ['decision', 'experiment'],
    project_name: 'STAKG-SP',
    limit_per_type: 20,
    include_sources: true,
  })
  assert.equal(result.value.status, 'OK')
  assert.equal(result.value.query, '0.0136%')
  assert.equal(result.value.count, 2)
  assert.equal(result.value.matches.decisions[0].title, '停止GNN直接定位优化')
  assert.equal(result.value.matches.experiments[0].name, 'GNN localization comparison')
  assert.deepEqual(result.value.applied_filters.entity_types, ['decision', 'experiment'])
  assert.equal(result.value.applied_filters.project_name, 'STAKG-SP')
  assert.equal(result.value.matches.decisions[0].sources[0].source.source_version, 'STEP-10')
  assert.equal(result.value.matches.experiments[0].sources[0].locator_start, 185)
  assert.ok(result.metrics.sqliteQueryMs >= 0)
  assert.ok(result.metrics.clientTotalMs >= result.metrics.sqliteQueryMs)
})

test('read-only client returns the complete STAKG-SP context', async () => {
  const client = await ResearchMemoryClient.create(config)
  const result = await client.getProjectContext({
    project_name: 'STAKG-SP',
    include_sources: true,
    limit_per_entity: 20,
  })
  assert.equal(result.value.project.name, 'STAKG-SP')
  assert.equal(result.value.project.status, 'active')
  assert.ok(result.value.decisions.some(item => item.title === '停止GNN直接定位优化'))
  assert.equal(result.value.experiments[0].name, 'GNN localization comparison')
  assert.equal(result.value.documents[0].path, 'Parent_Project_v0.5.5.pdf')
  assert.equal(result.value.documents[0].sources[0].locator_start, 186)
  assert.equal(result.value.applied_filters.include_sources, true)
})

test('unknown project produces a structured not-found error', async () => {
  const client = await ResearchMemoryClient.create(config)
  await assert.rejects(
    client.getProjectContext('unknown-project-test'),
    error => error instanceof MemoryClientError && error.code === 'MEMORY_NOT_FOUND',
  )
})

test('queries leave the SQLite database bytes and modification time unchanged', async () => {
  const client = await ResearchMemoryClient.create(config)
  const before = await databaseEvidence()
  await client.queryMemory('0.0136%')
  await client.getProjectContext('STAKG-SP')
  const after = await databaseEvidence()
  assert.deepEqual(after, before)
})

test('plugin source exposes four read operations and starts no shell', async () => {
  const sourcePaths = [
    path.join(repoRoot, 'plugins', 'research-memory', 'src', 'index.js'),
    path.join(repoRoot, 'plugins', 'research-memory', 'src', 'tools.js'),
    path.join(repoRoot, 'plugins', 'research-memory', 'src', 'client.js'),
  ]
  const sources = (await Promise.all(sourcePaths.map(item => readFile(item, 'utf8')))).join('\n')
  assert.match(sources, /name: 'memory_query'/u)
  assert.match(sources, /name: 'memory_get_project_context'/u)
  assert.match(sources, /name: 'memory_search_document_chunks'/u)
  assert.match(sources, /name: 'memory_get_document_chunk'/u)
  assert.match(sources, /entity_types/u)
  assert.match(sources, /project_name/u)
  assert.match(sources, /limit_per_type/u)
  assert.match(sources, /include_sources/u)
  assert.match(sources, /limit_per_entity/u)
  assert.match(sources, /version_scope/u)
  assert.match(sources, /max_total_chars/u)
  assert.match(sources, /include_content/u)
  assert.match(sources, /shell: false/u)
  assert.doesNotMatch(sources, /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/iu)
  assert.doesNotMatch(sources, /https?:\/\//iu)
})

test('Python bridge has exactly four read-only operations', async () => {
  const bridge = await readFile(path.join(repoRoot, 'memory', 'api', 'read_only_bridge.py'), 'utf8')
  const operationBranches = [...bridge.matchAll(/operation == "([^"]+)"/gu)].map(match => match[1])
  assert.deepEqual(operationBranches, [
    'query_memory',
    'get_project_context',
    'search_document_chunks',
    'get_document_chunk',
  ])
  assert.match(bridge, /read_only=True/u)
  assert.doesNotMatch(bridge, /\b(?:add_memory|add_source|link_record_source|document_ingest|commit_document_ingest|fts_rebuild)\b/u)
})

test('STEP-13 offline ingestion APIs are absent from the Cordis plugin', async () => {
  const pluginPaths = [
    path.join(repoRoot, 'plugins', 'research-memory', 'src', 'index.js'),
    path.join(repoRoot, 'plugins', 'research-memory', 'src', 'tools.js'),
    path.join(repoRoot, 'plugins', 'research-memory', 'src', 'client.js'),
  ]
  const pluginSource = (await Promise.all(pluginPaths.map(item => readFile(item, 'utf8')))).join('\n')
  assert.doesNotMatch(pluginSource, /\b(?:document_ingest|commit_document_ingest|fts_rebuild|ingest_runs)\b/u)
  assert.deepEqual(
    [...pluginSource.matchAll(/name: '(memory_[^']+)'/gu)].map(match => match[1]),
    [
      'memory_query',
      'memory_get_project_context',
      'memory_search_document_chunks',
      'memory_get_document_chunk',
    ],
  )
})

test('Document Chunk search returns bounded metadata and deterministic citations', async () => {
  const client = await ResearchMemoryClient.create(config)
  const result = await client.searchDocumentChunks({
    query: 'GNN localization comparison',
    project_name: 'STAKG-SP',
    version_scope: 'latest',
    limit: 5,
    max_total_chars: 2000,
  })
  assert.equal(result.value.status, 'OK')
  assert.equal(result.value.search_backend, 'fts5_trigram')
  assert.equal(result.value.returned_count, 1)
  const item = result.value.results[0]
  assert.equal(item.document_memory_id, 2)
  assert.equal(item.asset_id, 1)
  assert.equal(item.document_version_id, 1)
  assert.equal(item.source_id, 1)
  assert.equal(item.source_version, 'STEP-10')
  assert.match(item.memory_citation, /^\[Memory:document#2\]$/u)
  assert.match(item.source_citation, /^\[Source:1 /u)
  assert.match(item.chunk_citation, new RegExp(`^\\[Chunk:${item.chunk_uid} `, 'u'))
  assert.ok(result.value.total_returned_chars <= 2000)
})

test('exact Document Chunk read accepts a search result UID', async () => {
  const client = await ResearchMemoryClient.create(config)
  const search = await client.searchDocumentChunks({
    query: 'GNN localization comparison',
    project_name: 'STAKG-SP',
    limit: 1,
  })
  const chunk = await client.getDocumentChunk({
    chunk_uid: search.value.results[0].chunk_uid,
    include_content: true,
  })
  assert.equal(chunk.value.status, 'OK')
  assert.match(chunk.value.content, /GNN localization comparison/u)
  assert.equal(chunk.value.document_version_id, 1)
})

test('Document Chunk search returns a citation-free empty result', async () => {
  const client = await ResearchMemoryClient.create(config)
  const result = await client.searchDocumentChunks({
    query: 'THIS_CHUNK_QUERY_SHOULD_NOT_EXIST_987654',
    project_name: 'STAKG-SP',
  })
  assert.equal(result.value.status, 'NO_MATCH')
  assert.equal(result.value.returned_count, 0)
  assert.deepEqual(result.value.results, [])
})

test('invalid Document Chunk UID returns a structured bridge error', async () => {
  const client = await ResearchMemoryClient.create(config)
  await assert.rejects(
    client.getDocumentChunk({ chunk_uid: 'invalid' }),
    error => error instanceof MemoryClientError && error.code === 'MEMORY_VALIDATION_ERROR',
  )
})

test('production and test profiles point to different databases', async () => {
  const source = await readFile(path.join(repoRoot, 'apps', 'personal-workbench', 'server', 'src', 'config.ts'), 'utf8')
  assert.match(source, /memoryProduction:\s*LOCAL_CONFIG\.memory_path/u)
  assert.match(source, /memoryTest:\s*path\.join\(LOCAL_CONFIG\.project_path, 'memory', 'tests', 'test_research_memory\.db'\)/u)
  assert.notEqual(
    path.join(repoRoot, 'memory', 'database', 'research_memory.db'),
    path.join(repoRoot, 'memory', 'tests', 'test_research_memory.db'),
  )
})
