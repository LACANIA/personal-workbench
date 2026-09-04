import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { ProjectContextService } from '../src/projects/service.ts'
import { TaskManager } from '../src/tasks/manager.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe artifact test cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(): Promise<{ root: string; database: WorkbenchDatabase; artifacts: ArtifactService; projects: ProjectContextService; projectId: string }> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(path.join(root, 'output'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"artifact-fixture"}', 'utf8')
  temporaryRoots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  const artifacts = new ArtifactService(database)
  const projects = new ProjectContextService(database)
  const project = await projects.register({ rootPath: root, name: 'Artifact Fixture' })
  return { root, database, artifacts, projects, projectId: project.id }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('Artifact model and service', () => {
  it('registers a permitted file without storing its body', async () => {
    const test = await fixture(); const content = '# STEP-18\nArtifact acceptance.'; const file = path.join(test.root, 'output', 'report.md')
    await writeFile(file, content, 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file, artifact_type: 'report' })
    expect(artifact).toMatchObject({ project_id: test.projectId, task_id: null, artifact_type: 'report', name: 'report.md', relative_path: path.join('output', 'report.md'), mime_type: 'text/markdown' })
    expect(JSON.stringify(artifact)).not.toContain('Artifact acceptance.')
    test.database.close()
  })

  it('rejects a path outside the configured workspace allowlist', async () => {
    const test = await fixture()
    await expect(test.artifacts.register({ project_id: test.projectId, file_path: 'C:\\Windows', artifact_type: 'other' })).rejects.toThrow('PATH_POLICY_DENIED')
    test.database.close()
  })

  it('calculates the real SHA-256 and file size', async () => {
    const test = await fixture(); const content = 'hash-me'; const file = path.join(test.root, 'output', 'hash.txt'); await writeFile(file, content, 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file })
    expect(artifact.sha256).toBe(digest(content)); expect(artifact.size_bytes).toBe(Buffer.byteLength(content)); test.database.close()
  })

  it('associates a registered artifact with a task from the same project', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'task.json'); await writeFile(file, '{}', 'utf8')
    const task = test.database.createTask('artifact-task', { templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root })
    const artifact = await test.artifacts.register({ project_id: test.projectId, task_id: task.id, file_path: file, artifact_type: 'dataset' })
    expect(artifact.task_id).toBe(task.id); expect(test.artifacts.query({ task_id: task.id })).toEqual([artifact]); test.database.close()
  })

  it('queries by project and artifact type', async () => {
    const test = await fixture(); const report = path.join(test.root, 'output', 'a.md'); const data = path.join(test.root, 'output', 'b.csv')
    await writeFile(report, '# a', 'utf8'); await writeFile(data, 'a,b', 'utf8')
    await test.artifacts.register({ project_id: test.projectId, file_path: report, artifact_type: 'report' })
    await test.artifacts.register({ project_id: test.projectId, file_path: data, artifact_type: 'dataset' })
    expect(test.artifacts.query({ project_id: test.projectId })).toHaveLength(2)
    expect(test.artifacts.query({ project_id: test.projectId, artifact_type: 'report' })).toHaveLength(1)
    test.database.close()
  })

  it('adds an artifact_created event to the project timeline', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'timeline.md'); await writeFile(file, '# timeline', 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file, artifact_type: 'report' })
    expect(test.projects.timeline(test.projectId)).toContainEqual(expect.objectContaining({ type: 'artifact_created', artifact_id: artifact.id, name: 'timeline.md', artifact_type: 'report' }))
    test.database.close()
  })

  it('deletes only the index and leaves the real file unchanged', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'keep.md'); await writeFile(file, 'keep', 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file })
    expect(test.artifacts.deleteIndex(artifact.id).id).toBe(artifact.id)
    expect(test.artifacts.query({ project_id: test.projectId })).toHaveLength(0)
    expect(await readFile(file, 'utf8')).toBe('keep'); test.database.close()
  })

  it('rejects a file that does not exist', async () => {
    const test = await fixture()
    await expect(test.artifacts.register({ project_id: test.projectId, file_path: path.join(test.root, 'output', 'missing.md') })).rejects.toThrow('ARTIFACT_FILE_NOT_FOUND')
    test.database.close()
  })

  it('returns an existing index for the same project, task, path and hash', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'same.md'); await writeFile(file, 'same', 'utf8')
    const first = await test.artifacts.register({ project_id: test.projectId, file_path: file })
    const second = await test.artifacts.register({ project_id: test.projectId, file_path: file })
    expect(second.id).toBe(first.id); expect(test.artifacts.query({ project_id: test.projectId })).toHaveLength(1); test.database.close()
  })
})

describe('Task output candidates and API boundary', () => {
  it('discovers only the approved extensions inside fixed output directories', async () => {
    const test = await fixture(); await writeFile(path.join(test.root, 'output', 'candidate.md'), '# candidate', 'utf8'); await writeFile(path.join(test.root, 'output', 'ignored.exe'), 'x', 'utf8')
    const task = test.database.createTask('candidate-task', { templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root })
    const candidates = await test.artifacts.discoverTaskCandidates(task.id)
    expect(candidates.map(item => item.name)).toEqual(['candidate.md']); expect(test.artifacts.query({ task_id: task.id })).toHaveLength(0); test.database.close()
  })

  it('refreshes candidates after a deterministic task completes without registering them', async () => {
    const test = await fixture(); await writeFile(path.join(test.root, 'output', 'completed.txt'), 'completed', 'utf8')
    const manager = new TaskManager(test.database, test.artifacts)
    const task = manager.create({ templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root })
    await manager.start(task.id)
    for (let index = 0; index < 100 && manager.get(task.id)?.status !== 'completed'; index += 1) await delay(20)
    const completed = manager.get(task.id)!
    expect(completed.status).toBe('completed')
    expect(completed.artifactIndex).toContainEqual(expect.objectContaining({ name: 'completed.txt', registered_artifact_id: null }))
    expect(test.artifacts.query({ task_id: task.id })).toHaveLength(0)
    const artifact = await test.artifacts.register({ project_id: test.projectId, task_id: task.id, file_path: path.join(test.root, 'output', 'completed.txt') })
    expect(manager.get(task.id)?.artifactIndex).toContainEqual(expect.objectContaining({ name: 'completed.txt', registered_artifact_id: artifact.id }))
    test.database.close()
  })

  it('declares all required Artifact HTTP routes and never imports file deletion APIs', async () => {
    const apiSource = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8')
    const serviceSource = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'artifacts', 'service.ts'), 'utf8')
    for (const route of ['/api/artifacts', '/api/artifacts/register', '/artifacts']) expect(apiSource).toContain(route)
    expect(apiSource).toContain("request.method === 'DELETE'")
    expect(serviceSource).not.toMatch(/\b(?:unlink|rm|remove|writeFile|truncate)\b/u)
  })
})
