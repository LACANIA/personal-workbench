import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { ProjectContextService } from '../src/projects/service.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe artifact evidence cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(): Promise<{
  root: string
  database: WorkbenchDatabase
  evidence: ArtifactEvidenceService
  artifacts: ArtifactService
  projects: ProjectContextService
  projectId: string
}> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(path.join(root, 'output'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"artifact-evidence"}', 'utf8')
  temporaryRoots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  const evidence = new ArtifactEvidenceService(database)
  const artifacts = new ArtifactService(database, evidence)
  const projects = new ProjectContextService(database)
  const project = await projects.register({ rootPath: root, name: 'Artifact Evidence Fixture' })
  return { root, database, evidence, artifacts, projects, projectId: project.id }
}

async function reportArtifact(test: Awaited<ReturnType<typeof fixture>>, name = 'evidence-report.md') {
  const file = path.join(test.root, 'output', name)
  await writeFile(file, '# Evidence report', 'utf8')
  return test.artifacts.register({ project_id: test.projectId, file_path: file, artifact_type: 'report' })
}

function memoryFixture(): { decisionId: string; chunkUid: string; sourceId: string } {
  const db = new DatabaseSync(PATHS.memoryTest, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  try {
    const decision = db.prepare('SELECT id FROM decisions ORDER BY id LIMIT 1').get() as { id: number }
    const chunk = db.prepare('SELECT chunk_uid FROM document_chunks ORDER BY id LIMIT 1').get() as { chunk_uid: string }
    const source = db.prepare('SELECT id FROM sources ORDER BY id LIMIT 1').get() as { id: number }
    return { decisionId: String(decision.id), chunkUid: chunk.chunk_uid, sourceId: String(source.id) }
  } finally {
    db.close()
  }
}

describe('Artifact Evidence model and source validation', () => {
  it('creates and queries a relation without copying source content', async () => {
    const test = await fixture()
    const source = await reportArtifact(test, 'source.md')
    const target = await reportArtifact(test, 'target.md')
    const link = test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'derived_from' })
    expect(link).toMatchObject({ artifact_id: target.id, source_type: 'artifact', source_id: source.id, relation_type: 'derived_from', source: { available: true, label: 'source.md' } })
    expect(test.evidence.forArtifact(target.id)).toMatchObject({ count: 1, evidence: [expect.objectContaining({ id: link.id })] })
    expect(test.evidence.bySource('artifact', source.id)).toHaveLength(1)
    expect(JSON.stringify(test.database.getArtifactEvidenceLink(link.id))).not.toContain('# Evidence report')
    test.database.close()
  })

  it('automatically links a Task as generated_from', async () => {
    const test = await fixture()
    const task = test.database.createTask(randomUUID(), { templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root, title: 'Evidence Task' })
    const file = path.join(test.root, 'output', 'task-report.md'); await writeFile(file, 'task report', 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, task_id: task.id, file_path: file, artifact_type: 'report' })
    expect(test.evidence.forArtifact(artifact.id).evidence).toContainEqual(expect.objectContaining({ source_type: 'task', source_id: task.id, relation_type: 'generated_from' }))
    test.database.close()
  })

  it('automatically links a Harness Session as created_by', async () => {
    const test = await fixture()
    const task = test.database.createTask(randomUUID(), { templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root })
    test.database.updateTask(task.id, { harnessSessionId: 'session-step20-test' })
    const file = path.join(test.root, 'output', 'session-report.md'); await writeFile(file, 'session report', 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, task_id: task.id, file_path: file })
    expect(test.evidence.forArtifact(artifact.id).evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: 'task', relation_type: 'generated_from' }),
      expect.objectContaining({ source_type: 'session', source_id: 'session-step20-test', relation_type: 'created_by' }),
    ]))
    test.database.close()
  })

  it('links a Document Chunk using identifiers only', async () => {
    const test = await fixture(); const artifact = await reportArtifact(test); const { chunkUid } = memoryFixture()
    const link = test.evidence.create(artifact.id, { source_type: 'document_chunk', source_id: chunkUid, relation_type: 'references', database_role: 'test' })
    expect(link.metadata).toMatchObject({ database_role: 'test', chunk_id: expect.any(Number), document_id: expect.any(Number), version_id: expect.any(Number) })
    expect(Object.keys(link.metadata).sort()).toEqual(['chunk_id', 'database_role', 'document_id', 'version_id'])
    expect(JSON.stringify(link)).not.toContain('Research Memory STEP-10')
    test.database.close()
  })

  it('links a Research Memory entity through a read-only lookup', async () => {
    const test = await fixture(); const artifact = await reportArtifact(test); const { decisionId } = memoryFixture()
    const link = test.evidence.create(artifact.id, { source_type: 'memory', source_id: decisionId, memory_type: 'decision', relation_type: 'references', database_role: 'test' })
    expect(link).toMatchObject({ source_id: `decision:${decisionId}`, metadata: { database_role: 'test', memory_type: 'decision', memory_id: decisionId }, source: { available: true } })
    const memory = new DatabaseSync(PATHS.memoryTest, { readOnly: true }); memory.exec('PRAGMA query_only=ON')
    expect(memory.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 }); memory.close(); test.database.close()
  })

  it('links a Research Source without changing its database row', async () => {
    const test = await fixture(); const artifact = await reportArtifact(test); const { sourceId } = memoryFixture()
    const memory = new DatabaseSync(PATHS.memoryTest, { readOnly: true }); const before = memory.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId)
    const link = test.evidence.create(artifact.id, { source_type: 'source', source_id: sourceId, relation_type: 'verified_by', database_role: 'test' })
    const after = memory.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId); memory.close()
    expect(link.source.available).toBe(true); expect(after).toEqual(before); test.database.close()
  })

  it('rejects a Task source from another Workbench project', async () => {
    const test = await fixture(); const artifact = await reportArtifact(test)
    const secondRoot = path.join(test.root, 'second'); await mkdir(secondRoot); await writeFile(path.join(secondRoot, 'package.json'), '{}', 'utf8')
    await test.projects.register({ rootPath: secondRoot, name: 'Second Project' })
    const task = test.database.createTask(randomUUID(), { templateId: 'asset-inventory', inputType: 'directory', inputValue: secondRoot, workspacePath: secondRoot })
    await expect(Promise.resolve().then(() => test.evidence.create(artifact.id, { source_type: 'task', source_id: task.id, relation_type: 'generated_from' }))).rejects.toThrow('EVIDENCE_PROJECT_DENIED')
    test.database.close()
  })

  it('rejects a missing source and invalid source types', async () => {
    const test = await fixture(); const artifact = await reportArtifact(test)
    expect(() => test.evidence.create(artifact.id, { source_type: 'task', source_id: 'missing-task', relation_type: 'generated_from' })).toThrow('EVIDENCE_SOURCE_NOT_FOUND')
    expect(() => test.evidence.bySource('unknown', 'x')).toThrow('INVALID_EVIDENCE_SOURCE_TYPE')
    test.database.close()
  })

  it('deletes only the relation', async () => {
    const test = await fixture(); const source = await reportArtifact(test, 'kept-source.md'); const target = await reportArtifact(test, 'kept-target.md')
    const link = test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'references' })
    expect(test.evidence.delete(link.id).id).toBe(link.id)
    expect(test.evidence.forArtifact(target.id).count).toBe(0)
    expect(test.artifacts.get(source.id).id).toBe(source.id); expect(test.artifacts.get(target.id).id).toBe(target.id)
    test.database.close()
  })

  it('adds an evidence_linked event to the Project Timeline', async () => {
    const test = await fixture(); const source = await reportArtifact(test, 'timeline-source.md'); const target = await reportArtifact(test, 'timeline-target.md')
    const link = test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'verified_by' })
    expect(test.projects.timeline(test.projectId)).toContainEqual(expect.objectContaining({ type: 'evidence_linked', artifact_id: target.id, evidence_id: link.id, evidence_source_type: 'artifact', evidence_relation_type: 'verified_by' }))
    test.database.close()
  })
})

describe('Artifact Evidence migration and HTTP boundary', () => {
  it('keeps existing Artifact records readable after the Evidence table migration', async () => {
    const test = await fixture(); const artifact = await reportArtifact(test)
    expect(test.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact_evidence_links'").get()).toEqual({ name: 'artifact_evidence_links' })
    expect(test.artifacts.get(artifact.id).name).toBe('evidence-report.md')
    expect(test.database.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(test.database.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    test.database.close()
  })

  it('declares the token-protected Evidence routes and contains no Research Memory writes', async () => {
    const apiSource = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8')
    const serviceSource = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'artifacts', 'evidence-service.ts'), 'utf8')
    expect(apiSource).toContain('^\\/api\\/evidence\\/source\\/')
    expect(apiSource).toContain("action === 'evidence'")
    expect(apiSource).toContain("request.method === 'DELETE'")
    expect(serviceSource).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/u)
    expect(serviceSource).toContain("source_type: 'session'")
  })
})
