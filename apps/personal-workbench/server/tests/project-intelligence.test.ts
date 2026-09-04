import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AssetInventoryResult } from '../src/assets/inventory.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { listProjects } from '../src/memory/service.ts'
import { ProjectContextService } from '../src/projects/service.ts'

const temporaryRoots: string[] = []
const signals = { hasSrc: true, hasDocs: false, hasReadme: true, hasPackageJson: true, hasPyprojectToml: false, hasPdf: false }

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe intelligence test cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(): Promise<string> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'README.md'), '# fixture', 'utf8')
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}', 'utf8')
  temporaryRoots.push(root)
  return root
}

function inventory(root: string, fileCount: number, totalBytes: number, extensions: string[]): AssetInventoryResult {
  return {
    status: 'OK', canonicalRoot: root, fileCount, directoryCount: 2, totalBytes,
    extensionDistribution: extensions.map((extension, index) => ({ extension, count: fileCount - index })),
    recentFiles: [], largeFiles: [], skippedCount: 0, skippedPreview: [], durationMs: 1,
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('Project Snapshot History and change detection', () => {
  it('retains every scan as a separate history item', async () => {
    const root = await fixture(); const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const project = await service.register({ rootPath: root, name: 'History' })
    await service.scan(project.id); await service.scan(project.id)
    const history = service.history(project.id)
    expect(history).toHaveLength(2)
    expect(history[0]).toEqual(expect.objectContaining({ scan_time: expect.any(String), file_count: expect.any(Number), extension_summary: expect.any(Array) }))
    expect(db.listProjectAssetSnapshots(project.id)).toHaveLength(2)
    db.close()
  })

  it('compares the latest two aggregate snapshots', async () => {
    const root = await fixture(); const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const project = await service.register({ rootPath: root, name: 'Changes' })
    db.saveProjectAssetSnapshot('snapshot-1', project.id, inventory(root, 10, 1000, ['.ts', '.json']), signals, '2026-08-20T00:00:00.000Z')
    db.saveProjectAssetSnapshot('snapshot-2', project.id, inventory(root, 15, 1600, ['.ts', '.md']), signals, '2026-08-21T00:00:00.000Z')
    const summary = service.detail(project.id).changeSummary
    expect(summary).toMatchObject({ added_files_estimate: 5, file_count_change: 5, size_change: 600, file_change_ratio: 0.5, new_extensions: ['.md'], removed_extensions: ['.json'] })
    db.close()
  })

  it('returns no comparison until a second snapshot exists', async () => {
    const root = await fixture(); const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const project = await service.register({ rootPath: root }); await service.scan(project.id)
    expect(service.detail(project.id).changeSummary).toBeNull(); db.close()
  })
})

describe('Project Timeline', () => {
  it('combines creation, scan, completed task and Memory reference events', async () => {
    const root = await fixture(); const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const project = await service.register({ rootPath: root, name: 'Timeline' }); await service.scan(project.id)
    db.createTask('timeline-task', { templateId: 'asset-inventory', inputType: 'directory', inputValue: root, workspacePath: root })
    db.updateTask('timeline-task', { status: 'completed', completedAt: '2026-08-21T01:00:00.000Z' })
    db.upsertProjectMemoryReference({ id: 'timeline-memory', projectId: project.id, memoryRole: 'test', memoryProjectName: 'STAKG-SP', memoryEntityType: 'project', memoryEntityId: '1' })
    const types = service.timeline(project.id).map(event => event.type)
    expect(types).toEqual(expect.arrayContaining(['project_created', 'scan_completed', 'task_completed', 'memory_linked']))
    expect(service.timeline(project.id).every(event => event.timestamp && event.title && event.source)).toBe(true)
    db.close()
  })
})

describe('explicit Memory binding', () => {
  it('adds and removes a Workbench-only reference without changing Research Memory', async () => {
    const memoryPath = PATHS.memoryTest; const before = sha256(await readFile(memoryPath))
    const memoryProject = listProjects('test')[0]!
    const root = await fixture(); const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const project = await service.register({ rootPath: root, name: 'Explicit Binding' })
    const linked = service.linkMemory(project.id, String(memoryProject.id), 'test')
    expect(linked.memoryReferences).toEqual([expect.objectContaining({ memoryRole: 'test', memoryEntityId: String(memoryProject.id) })])
    const unlinked = service.unlinkMemory(project.id, String(memoryProject.id), 'test')
    expect(unlinked.memoryReferenceCount).toBe(0)
    expect(sha256(await readFile(memoryPath))).toBe(before)
    db.close()
  })

  it('rejects unknown Memory project identifiers', async () => {
    const root = await fixture(); const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const project = await service.register({ rootPath: root })
    expect(() => service.linkMemory(project.id, 'missing-memory-project', 'test')).toThrow('MEMORY_PROJECT_NOT_FOUND')
    db.close()
  })
})

describe('recommended actions and HTTP routes', () => {
  it('returns structured actions while preserving STEP-16 labels', async () => {
    const root = await fixture(); const db = new WorkbenchDatabase(path.join(root, 'workbench.db')); const service = new ProjectContextService(db)
    const project = await service.register({ rootPath: root, name: 'Actions' })
    expect(project.actions.map(action => action.action_type)).toEqual(['create_task', 'rescan_project', 'generate_report'])
    expect(project.actions.find(action => action.action_type === 'create_task')?.payload).toMatchObject({ templateId: 'asset-inventory', workspacePath: root })
    expect(project.recommendedActions).toContain('资产清单')
    db.close()
  })

  it('exposes history, timeline and Memory link routes', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8')
    expect(source).toContain('scan|history|timeline|memory-link')
    expect(source).toContain("request.method === 'DELETE'")
    expect(source).toContain('projects.history(id')
    expect(source).toContain('projects.timeline(id')
  })
})
