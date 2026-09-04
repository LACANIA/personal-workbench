import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskCreateInput } from '../../shared/contracts/index.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { detectProjectType, ProjectContextService } from '../src/projects/service.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe project test cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(): Promise<string> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(root, { recursive: true })
  temporaryRoots.push(root)
  return root
}

async function nodeProject(root: string): Promise<void> {
  await mkdir(path.join(root, 'src'))
  await mkdir(path.join(root, 'docs'))
  await writeFile(path.join(root, 'README.md'), '# fixture', 'utf8')
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}', 'utf8')
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1', 'utf8')
}

function taskInput(filePath: string): TaskCreateInput {
  return { templateId: 'file-analysis', inputType: 'file', inputValue: filePath, workspacePath: path.dirname(filePath) }
}

describe('Project Context database model', () => {
  it('creates Project, Asset and Memory reference tables plus task project_id', async () => {
    const root = await fixture(); const db = new WorkbenchDatabase(path.join(root, 'workbench.db'))
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String((row as { name: string }).name))
    expect(tables).toEqual(expect.arrayContaining(['project_contexts', 'project_asset_snapshots', 'project_memory_references']))
    const columns = db.db.prepare("PRAGMA table_info('workbench_tasks')").all().map(row => String((row as { name: string }).name))
    expect(columns).toContain('project_id'); db.close()
  })

  it('keeps scan snapshots free of file body columns', async () => {
    const root = await fixture(); const db = new WorkbenchDatabase(path.join(root, 'workbench.db'))
    const columns = db.db.prepare("PRAGMA table_info('project_asset_snapshots')").all().map(row => String((row as { name: string }).name))
    expect(columns).not.toContain('content'); expect(columns).not.toContain('body'); db.close()
  })
})

describe('Project Context API service', () => {
  it('registers, lists and retrieves an allowed project', async () => {
    const root = await fixture(); await nodeProject(root)
    const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const created = await service.register({ rootPath: root, name: 'Fixture Project', description: 'API test' })
    expect(created.name).toBe('Fixture Project'); expect(created.projectType).toBe('node'); expect(service.list()).toHaveLength(1); expect(service.detail(created.id).rootPath).toBe(root)
    db.close()
  })

  it('treats repeat registration as idempotent', async () => {
    const root = await fixture(); await nodeProject(root)
    const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const first = await service.register({ rootPath: root }); const second = await service.register({ rootPath: root })
    expect(second.id).toBe(first.id); expect(service.list()).toHaveLength(1); db.close()
  })

  it('exposes all four Project API routes in the HTTP service', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8')
    expect(source).toContain("'/api/projects/context'")
    expect(source).toContain("'/api/projects/register'")
    expect(source).toContain('scan|history|timeline|memory-link')
    expect(source).toContain('projects.detail(id)')
  })
})

describe('Project type recognition and scanning', () => {
  it('recognizes Node, Python and research roots from top-level signals', async () => {
    const nodeRoot = await fixture(); await nodeProject(nodeRoot); expect((await detectProjectType(nodeRoot)).projectType).toBe('node')
    const pythonRoot = await fixture(); await writeFile(path.join(pythonRoot, 'pyproject.toml'), '[project]', 'utf8'); expect((await detectProjectType(pythonRoot)).projectType).toBe('python')
    const researchRoot = await fixture(); await writeFile(path.join(researchRoot, 'paper.pdf'), 'fixture', 'utf8'); expect((await detectProjectType(researchRoot)).projectType).toBe('research')
  })

  it('stores bounded asset statistics and a scan timestamp', async () => {
    const root = await fixture(); await nodeProject(root)
    const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const created = await service.register({ rootPath: root }); const scanned = await service.scan(created.id)
    expect(scanned.lastScanAt).not.toBeNull(); expect(scanned.assetStats?.fileCount).toBeGreaterThanOrEqual(3); expect(scanned.assetStats?.directoryCount).toBe(3)
    expect(scanned.assetStats?.detectedSignals.hasPackageJson).toBe(true); db.close()
  })

  it('rejects a project outside the configured root', async () => {
    const root = await fixture(); const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    await expect(service.register({ rootPath: 'C:\\Windows' })).rejects.toThrow('PATH_POLICY_DENIED'); db.close()
  })
})

describe('automatic task and Memory association', () => {
  it('associates a new task when its path belongs to a registered project', async () => {
    const root = await fixture(); await nodeProject(root)
    const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const project = await service.register({ rootPath: root }); const task = db.createTask('task-linked', taskInput(path.join(root, 'package.json')))
    expect(task.projectId).toBe(project.id); expect(service.detail(project.id).taskCount).toBe(1); db.close()
  })

  it('backfills an existing task when the project is registered later', async () => {
    const root = await fixture(); await nodeProject(root)
    const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); db.createTask('task-before', taskInput(path.join(root, 'package.json')))
    const service = new ProjectContextService(db); const project = await service.register({ rootPath: root })
    expect(db.getTask('task-before')?.projectId).toBe(project.id); db.close()
  })

  it('uses the most specific registered root for a nested task', async () => {
    const root = await fixture(); await mkdir(path.join(root, 'nested')); await writeFile(path.join(root, 'nested', 'a.txt'), 'a', 'utf8')
    const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    await service.register({ rootPath: root, name: 'Outer' }); const nested = await service.register({ rootPath: path.join(root, 'nested'), name: 'Nested' })
    const task = db.createTask('task-nested', taskInput(path.join(root, 'nested', 'a.txt'))); expect(task.projectId).toBe(nested.id); db.close()
  })

  it('records a read-only Memory project reference without changing Research Memory', async () => {
    const root = await fixture(); await writeFile(path.join(root, 'README.md'), '# STAKG-SP', 'utf8')
    const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const project = await service.register({ rootPath: root, name: 'STAKG-SP' })
    expect(project.memoryReferences.some(reference => reference.memoryRole === 'test' && reference.memoryProjectName === 'STAKG-SP')).toBe(true)
    db.close()
  })
})
