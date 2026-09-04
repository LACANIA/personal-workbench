import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskCreateInput, WorkbenchTask } from '../../shared/contracts/index.ts'
import { allowsLegacyTransition, LEGACY_VIDEO_TASK_STATES } from '../../../../integrations/video2skill-legacy/src/index.ts'
import { collectAssetInventory } from '../src/assets/inventory.ts'
import { PATHS, PROFILE_ALLOWLIST, TEMPLATES, profileForTemplate, templateById } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { getLegacyReuseStatus } from '../src/health/checks.ts'
import { buildHarnessPrompt, extractCitations, sanitizeHarnessNotification, shouldPersistHarnessNotification } from '../src/harness/adapter.ts'
import { bridgeRequest, listProjects, readMemoryStatus } from '../src/memory/service.ts'
import { assertAllowedExisting, loadAllowedRoots } from '../src/security/path-policy.ts'
import { normalizeFileAnalysisResponse, TaskManager, verifiedPackageRequirements } from '../src/tasks/manager.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe test cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function temporaryRoot(): Promise<string> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(root, { recursive: true })
  temporaryRoots.push(root)
  return root
}

function input(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return { templateId: 'file-analysis', inputValue: path.join(PATHS.appRoot, 'package.json'), inputType: 'file', ...overrides }
}

describe('Workbench configuration', () => {
  it('exposes eight fixed templates including knowledge ingestion and file organizer', () => {
    expect(TEMPLATES).toHaveLength(8)
    expect(TEMPLATES.some(template => template.id === 'knowledge-ingestion')).toBe(true)
    expect(TEMPLATES.some(template => template.id === 'file-organizer')).toBe(true)
  })
  it('maps file analysis to the safe Profile', () => expect(profileForTemplate('file-analysis', 'production')).toBe('personal-safe-readonly'))
  it('maps production research tasks to the production Profile', () => expect(profileForTemplate('memory-query', 'production')).toBe('personal-research'))
  it('maps development research tasks to the test Profile', () => expect(profileForTemplate('document-chunk-search', 'test')).toBe('personal-research-test'))
  it('keeps every model-facing Profile in the allowlist', () => {
    for (const template of TEMPLATES.filter(item => item.execution === 'harness')) expect(profileForTemplate(template.id, 'production') in PROFILE_ALLOWLIST).toBe(true)
  })
  it('rejects unknown templates', () => expect(() => templateById('unknown' as never)).toThrow('UNKNOWN_TEMPLATE'))
  it('pins the local endpoint in the SDK overlay source', async () => expect(await readFile(path.join(PATHS.appRoot, 'server', 'src', 'config.ts'), 'utf8')).toContain("endpoint.pathname = '/v1'"))
  it('uses Ollama no-reasoning mode so the output budget remains available for the answer', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'config.ts'), 'utf8')
    expect(source).toContain('reasoning: off')
    expect(source).toContain('off: none')
  })
  it('disables both one-shot headless components in the SDK overlay', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'config.ts'), 'utf8'); expect(source).toContain('id: headless-startup'); expect(source).toContain('id: headless-runner')
  })
  it('detects Ollama from portable configuration and keeps the optional code model explicit', async () => {
    const [portable, desktop] = await Promise.all([
      readFile(path.join(PATHS.appRoot, 'server', 'src', 'portable-config.ts'), 'utf8'),
      readFile(path.join(PATHS.appRoot, 'desktop', 'runtime.mjs'), 'utf8'),
    ])
    expect(portable).toContain("detectExecutable('ollama'")
    expect(portable).toContain('ollama_executable')
    expect(desktop).toContain("'qwen2.5-coder:7b'")
  })
})

describe('Workbench task database', () => {
  it('creates the required task record', async () => {
    const root = await temporaryRoot(); const db = new WorkbenchDatabase(path.join(root, 'tasks.db'))
    const task = db.createTask('task-1', input()); expect(task.status).toBe('created'); expect(task.permissionMode).toBe('read-only'); db.close()
  })
  it('stores a test database role without accepting a raw Profile', async () => {
    const root = await temporaryRoot(); const db = new WorkbenchDatabase(path.join(root, 'tasks.db'))
    const task = db.createTask('task-2', input({ templateId: 'memory-query', databaseRole: 'test' })); expect(task.profile).toBe('personal-research-test'); expect(task.metadata.databaseRole).toBe('test'); db.close()
  })
  it('updates status and result', async () => {
    const root = await temporaryRoot(); const db = new WorkbenchDatabase(path.join(root, 'tasks.db')); db.createTask('task-3', input())
    const task = db.updateTask('task-3', { status: 'completed', resultText: 'OK' }); expect(task.resultText).toBe('OK'); db.close()
  })
  it('records ordered events', async () => {
    const root = await temporaryRoot(); const db = new WorkbenchDatabase(path.join(root, 'tasks.db')); db.createTask('task-4', input()); db.addEvent('task-4', 'one', 'workbench', { n: 1 }); db.addEvent('task-4', 'two', 'harness', { n: 2 }); expect(db.listEvents('task-4').map(item => item.eventType)).toEqual(['task.created', 'one', 'two']); db.close()
  })
  it('limits task listing', async () => {
    const root = await temporaryRoot(); const db = new WorkbenchDatabase(path.join(root, 'tasks.db')); db.createTask('a', input()); db.createTask('b', input()); expect(db.listTasks(1)).toHaveLength(1); db.close()
  })
  it('rejects client-submitted Profile and command controls', async () => {
    const root = await temporaryRoot(); const db = new WorkbenchDatabase(path.join(root, 'tasks.db')); const manager = new TaskManager(db)
    expect(() => manager.create({ ...input(), profile: 'personal-research-test' } as TaskCreateInput)).toThrow('CLIENT_EXECUTION_CONTROL_DENIED')
    expect(() => manager.create({ ...input(), command: 'powershell.exe' } as TaskCreateInput)).toThrow('CLIENT_EXECUTION_CONTROL_DENIED')
    expect(() => manager.create({ ...input(), projectId: 'client-controlled' } as TaskCreateInput)).toThrow('CLIENT_EXECUTION_CONTROL_DENIED')
    db.close()
  })
  it('normalizes model citation placeholders and angle-wrapped paths', () => {
    const canonical = 'C:\\workspace\\package.json'
    expect(normalizeFileAnalysisResponse(`<${canonical}>:7`, canonical)).toBe(`${canonical}:7`)
    expect(normalizeFileAnalysisResponse('<canonical_path>:<line-9-10>', canonical)).toBe(`${canonical}:9-10`)
  })
  it('derives exact package requirement lines without a model', () => {
    const canonical = 'C:\\workspace\\fixture\\package.json'
    const result = verifiedPackageRequirements('{\n  "packageManager": "pnpm@11.7.0",\n  "engines": {\n    "node": ">=24"\n  }\n}', canonical)
    expect(result).toContain(`${canonical}:2: packageManager = pnpm@11.7.0`)
    expect(result).toContain(`${canonical}:3-4: Node.js = >=24`)
  })
})

describe('Path policy and deterministic inventory', () => {
  it('loads a configured root that contains the application', async () => {
    const application = path.resolve(PATHS.appRoot).toLowerCase()
    const roots = await loadAllowedRoots()
    expect(roots.some(root => {
      const candidate = path.resolve(root).toLowerCase()
      return application === candidate || application.startsWith(`${candidate}${path.sep}`)
    })).toBe(true)
  })
  it('allows an existing application package file', async () => expect(await assertAllowedExisting(path.join(PATHS.appRoot, 'package.json'), 'file')).toMatch(/package\.json$/u))
  it('rejects a path outside the allowed root', async () => await expect(assertAllowedExisting('C:\\Windows', 'directory')).rejects.toThrow('PATH_POLICY_DENIED'))
  it('rejects UNC syntax', async () => await expect(assertAllowedExisting('\\\\server\\share', 'any')).rejects.toThrow('PATH_POLICY_DENIED'))
  it('counts a controlled fixture without following links', async () => {
    const root = await temporaryRoot(); await writeFile(path.join(root, 'a.txt'), 'a', 'utf8'); await mkdir(path.join(root, 'sub')); await writeFile(path.join(root, 'sub', 'b.ts'), 'bb', 'utf8')
    const result = await collectAssetInventory(root); expect(result.fileCount).toBe(2); expect(result.directoryCount).toBe(2); expect(result.totalBytes).toBe(3)
  })
})

describe('Harness adapter boundaries', () => {
  const task = { id: 'x', templateId: 'file-analysis', inputValue: 'C:\\workspace\\package.json', projectName: null } as WorkbenchTask
  it('builds a tool-required file prompt', () => expect(buildHarnessPrompt(task)).toContain('personal_read'))
  it('builds a two-stage Chunk prompt', () => expect(buildHarnessPrompt({ ...task, templateId: 'document-chunk-search', projectName: 'STAKG-SP' })).toContain('memory_get_document_chunk'))
  it('extracts Memory, Source and Chunk citations', () => expect(extractCitations('[Memory:document#2] [Source:1 E:\\x.md:1-2] [Chunk:abc E:\\x.md:1-2]')).toHaveLength(3))
  it('hides credential-shaped event fields', () => {
    const value = sanitizeHarnessNotification({ method: 'x', params: { apiKey: 'secret', value: 'ok' } }); expect(value.params.apiKey).toBe('[已隐藏]')
  })
  it('does not persist token-level assistant chunks', () => {
    expect(shouldPersistHarnessNotification({ method: 'session.event', params: { event: { type: 'assistant/chunk' } } })).toBe(false)
  })
  it('removes complete tool text before event storage', () => {
    const value = sanitizeHarnessNotification({ method: 'session.event', params: { event: { type: 'tool/result', data: { message: { content: [{ type: 'text', text: JSON.stringify({ canonical_path: 'E:\\x.txt', content: 'private body' }) }] } } } } })
    expect(JSON.stringify(value)).not.toContain('private body')
    expect(JSON.stringify(value)).toContain('正文未写入')
  })
  it('uses spawn-oriented source without shell commands', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'harness', 'adapter.ts'), 'utf8'); expect(source).not.toMatch(/exec\s*\(/u); expect(source).toContain('PATHS.harnessCli')
  })
})

describe('Research Memory read-only integration', () => {
  it('reports Schema v4 for both databases', () => { expect(readMemoryStatus('production').userVersion).toBe(4); expect(readMemoryStatus('test').userVersion).toBe(4) })
  it('reports an empty production Chunk index', () => { const status = readMemoryStatus('production'); expect(status.ftsCount).toBe(0) })
  it('reports three indexed test Chunks', () => { const status = readMemoryStatus('test'); expect(status.ftsCount).toBe(3); expect((status.counts as Record<string, number>).document_chunks).toBe(3) })
  it('lists STAKG-SP only from the test database', () => { expect(listProjects('production')).toHaveLength(0); expect(listProjects('test').some(item => item.name === 'STAKG-SP')).toBe(true) })
  it('searches test Chunks through the four-operation bridge', async () => {
    const response = await bridgeRequest('test', { operation: 'search_document_chunks', query: 'GNN localization comparison', project_name: 'STAKG-SP', limit: 3 }); expect(response.ok).toBe(true); expect(((response.result as Record<string, unknown>).returned_count)).toBe(1)
  })
  it('returns no production match through the bridge', async () => {
    const response = await bridgeRequest('production', { operation: 'search_document_chunks', query: 'GNN localization comparison', limit: 3 }); expect(response.ok).toBe(true); expect(((response.result as Record<string, unknown>).returned_count)).toBe(0)
  })
})

describe('Legacy contract adaptation', () => {
  it('contains the ten planned states', () => expect(LEGACY_VIDEO_TASK_STATES).toHaveLength(10))
  it('allows the initial inspection transition', () => expect(allowsLegacyTransition('CREATED', 'INSPECTING')).toBe(true))
  it('rejects a completed task transition', () => expect(allowsLegacyTransition('COMPLETED', 'FAILED')).toBe(false))
  it('has no developer-specific desktop path in adapted source', async () => {
    const source = fileURLToPath(new URL('../../../../integrations/video2skill-legacy/src/index.ts', import.meta.url))
    expect(await readFile(source, 'utf8')).not.toMatch(/C:\\Users\\[^\\]+\\Desktop/iu)
  })
  it('reads the bounded reuse manifest when present and otherwise reports an empty result', async () => { const status = await getLegacyReuseStatus(); expect(status.totalCandidates).toBeGreaterThanOrEqual(0); expect(status.mediaPipelineEnabled).toBe(false) })
})
