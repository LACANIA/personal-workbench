import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { EvidenceAuditService } from '../src/artifacts/evidence-audit-service.ts'
import { ArtifactIntelligenceService } from '../src/artifacts/intelligence-service.ts'
import { ProvenanceExportService } from '../src/artifacts/provenance-export-service.ts'
import { ProvenanceGraphService } from '../src/artifacts/provenance-graph-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { ProjectContextService } from '../src/projects/service.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe provenance cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(path.join(root, 'output'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"provenance-fixture"}', 'utf8')
  temporaryRoots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  const evidence = new ArtifactEvidenceService(database)
  const artifacts = new ArtifactService(database, evidence)
  const projects = new ProjectContextService(database)
  const project = await projects.register({ rootPath: root, name: 'Provenance Fixture' })
  return {
    root,
    database,
    evidence,
    artifacts,
    projects,
    projectId: project.id,
    graph: new ProvenanceGraphService(database, evidence),
    intelligence: new ArtifactIntelligenceService(database, artifacts),
    audit: new EvidenceAuditService(database, artifacts, evidence),
    exporter: new ProvenanceExportService(database, artifacts),
  }
}

async function artifact(test: Awaited<ReturnType<typeof fixture>>, name: string, content = `# ${name}`) {
  const file = path.join(test.root, 'output', name)
  await writeFile(file, content, 'utf8')
  return test.artifacts.register({ project_id: test.projectId, file_path: file, artifact_type: 'report' })
}

function memoryFixture(): { decisionId: string; chunkUid: string; sourceId: string } {
  const database = new DatabaseSync(PATHS.memoryTest, { readOnly: true })
  database.exec('PRAGMA query_only=ON')
  try {
    const decision = database.prepare('SELECT id FROM decisions ORDER BY id LIMIT 1').get() as { id: number }
    const chunk = database.prepare('SELECT chunk_uid FROM document_chunks ORDER BY id LIMIT 1').get() as { chunk_uid: string }
    const source = database.prepare('SELECT id FROM sources ORDER BY id LIMIT 1').get() as { id: number }
    return { decisionId: String(decision.id), chunkUid: chunk.chunk_uid, sourceId: String(source.id) }
  } finally {
    database.close()
  }
}

describe('Provenance Graph', () => {
  it('generates an Artifact-centered graph from Evidence links', async () => {
    const test = await fixture()
    const task = test.database.createTask(randomUUID(), { templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root, title: 'Provenance Task' })
    test.database.updateTask(task.id, { harnessSessionId: 'provenance-session' })
    const file = path.join(test.root, 'output', 'generated.md'); await writeFile(file, '# Generated', 'utf8')
    const target = await test.artifacts.register({ project_id: test.projectId, task_id: task.id, file_path: file, artifact_type: 'report' })
    const graph = test.graph.artifact(target.id)
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `artifact:${target.id}`, type: 'artifact', status: 'active' }),
      expect.objectContaining({ id: `task:${task.id}`, type: 'task', status: 'created' }),
      expect.objectContaining({ id: 'session:provenance-session', type: 'session', status: 'available' }),
    ]))
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: `artifact:${target.id}`, target: `task:${task.id}`, relation_type: 'generated_from' }),
      expect.objectContaining({ source: `artifact:${target.id}`, target: 'session:provenance-session', relation_type: 'created_by' }),
    ]))
    test.database.close()
  })

  it('includes every supported node type without source bodies', async () => {
    const test = await fixture(); const target = await artifact(test, 'target.md'); const sourceArtifact = await artifact(test, 'source.md', 'SOURCE_BODY_MUST_NOT_APPEAR')
    const task = test.database.createTask(randomUUID(), { templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root })
    test.database.updateTask(task.id, { harnessSessionId: 'all-types-session' })
    const memory = memoryFixture()
    test.evidence.create(target.id, { source_type: 'task', source_id: task.id, relation_type: 'generated_from' })
    test.evidence.create(target.id, { source_type: 'session', source_id: 'all-types-session', relation_type: 'created_by' })
    test.evidence.create(target.id, { source_type: 'memory', source_id: memory.decisionId, memory_type: 'decision', database_role: 'test', relation_type: 'references' })
    test.evidence.create(target.id, { source_type: 'document_chunk', source_id: memory.chunkUid, database_role: 'test', relation_type: 'references' })
    test.evidence.create(target.id, { source_type: 'source', source_id: memory.sourceId, database_role: 'test', relation_type: 'verified_by' })
    test.evidence.create(target.id, { source_type: 'artifact', source_id: sourceArtifact.id, relation_type: 'derived_from' })
    const graph = test.graph.artifact(target.id)
    expect(new Set(graph.nodes.map(node => node.type))).toEqual(new Set(['artifact', 'task', 'session', 'memory', 'document_chunk', 'source']))
    expect(graph.edges).toHaveLength(6)
    expect(JSON.stringify(graph)).not.toContain('SOURCE_BODY_MUST_NOT_APPEAR')
    test.database.close()
  })

  it('limits a project graph to Artifacts registered in that Project Context', async () => {
    const test = await fixture(); const first = await artifact(test, 'first.md')
    const secondRoot = path.join(test.root, 'second'); await mkdir(path.join(secondRoot, 'output'), { recursive: true }); await writeFile(path.join(secondRoot, 'package.json'), '{}', 'utf8')
    const secondProject = await test.projects.register({ rootPath: secondRoot, name: 'Second Project' })
    const secondFile = path.join(secondRoot, 'output', 'second.md'); await writeFile(secondFile, 'second', 'utf8')
    const second = await test.artifacts.register({ project_id: secondProject.id, file_path: secondFile })
    const graph = test.graph.project(test.projectId)
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: `artifact:${first.id}` }))
    expect(graph.nodes).not.toContainEqual(expect.objectContaining({ id: `artifact:${second.id}` }))
    expect(() => test.evidence.create(first.id, { source_type: 'artifact', source_id: second.id, relation_type: 'references' })).toThrow('EVIDENCE_PROJECT_DENIED')
    test.database.close()
  })
})

describe('Evidence Audit', () => {
  it('returns healthy and saves an audit record when all sources are valid', async () => {
    const test = await fixture(); const source = await artifact(test, 'healthy-source.md'); const target = await artifact(test, 'healthy-target.md')
    test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'verified_by' })
    const report = test.audit.auditArtifact(target.id)
    expect(report).toMatchObject({ status: 'healthy', issues: [], evidence_count: 1, audit_id: expect.any(String) })
    expect(test.database.listArtifactProvenanceAudits(target.id)).toHaveLength(1)
    test.database.close()
  })

  it('returns broken when an Evidence source disappears', async () => {
    const test = await fixture(); const source = await artifact(test, 'broken-source.md'); const target = await artifact(test, 'broken-target.md')
    test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'references' })
    test.database.deleteArtifact(source.id)
    const report = test.audit.inspectArtifact(target.id)
    expect(report.status).toBe('broken')
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_SOURCE_UNAVAILABLE', severity: 'broken', source_id: source.id }))
    test.database.close()
  })

  it('reports a corrupted cross-project Evidence relation as broken', async () => {
    const test = await fixture(); const target = await artifact(test, 'cross-project.md')
    const secondRoot = path.join(test.root, 'external'); await mkdir(secondRoot); await writeFile(path.join(secondRoot, 'package.json'), '{}', 'utf8')
    await test.projects.register({ rootPath: secondRoot, name: 'External Project' })
    const task = test.database.createTask(randomUUID(), { templateId: 'asset-inventory', inputType: 'directory', inputValue: secondRoot, workspacePath: secondRoot })
    test.database.createArtifactEvidenceLink({ id: randomUUID(), artifact_id: target.id, source_type: 'task', source_id: task.id, relation_type: 'references', created_at: new Date().toISOString(), metadata: {} })
    const report = test.audit.inspectArtifact(target.id)
    expect(report.status).toBe('broken')
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_CROSS_PROJECT', source_id: task.id }))
    test.database.close()
  })

  it('returns warning when Artifact health is outdated', async () => {
    const test = await fixture(); const source = await artifact(test, 'outdated-source.md'); const target = await artifact(test, 'outdated-target.md')
    test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'references' })
    await writeFile(target.absolute_path, '# Changed', 'utf8'); await test.intelligence.check(target.id)
    const report = test.audit.inspectArtifact(target.id)
    expect(report.status).toBe('warning')
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'ARTIFACT_OUTDATED', severity: 'warning' }))
    test.database.close()
  })

  it('returns a project audit without creating audit records', async () => {
    const test = await fixture(); const target = await artifact(test, 'project-audit.md')
    const report = test.audit.auditProject(test.projectId)
    expect(report).toMatchObject({ project_id: test.projectId, status: 'warning', artifact_count: 1, issue_count: 1 })
    expect(report.artifacts[0]).toMatchObject({ artifact_id: target.id, audit_id: null, status: 'warning' })
    expect(test.database.listArtifactProvenanceAudits(target.id)).toHaveLength(0)
    test.database.close()
  })

  it('adds audit_completed to the Project Timeline', async () => {
    const test = await fixture(); const source = await artifact(test, 'timeline-source.md'); const target = await artifact(test, 'timeline-target.md')
    test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'verified_by' })
    const report = test.audit.auditArtifact(target.id)
    expect(test.projects.timeline(test.projectId)).toContainEqual(expect.objectContaining({ type: 'audit_completed', artifact_id: target.id, audit_id: report.audit_id, audit_status: 'healthy', audit_issue_count: 0 }))
    test.database.close()
  })
})

describe('Provenance Manifest and migration', () => {
  it('exports identifiers, relations and hash without paths or source content', async () => {
    const test = await fixture(); const source = await artifact(test, 'manifest-source.md', 'PRIVATE_SOURCE_BODY'); const target = await artifact(test, 'manifest-target.md')
    test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'derived_from' })
    const manifest = test.exporter.manifest(target.id)
    expect(manifest).toMatchObject({ manifest_version: '1', artifact: { id: target.id, project_id: test.projectId }, hash: target.sha256, relations: [expect.objectContaining({ source_id: source.id, relation_type: 'derived_from' })] })
    const serialized = JSON.stringify(manifest)
    expect(serialized).not.toContain('absolute_path'); expect(serialized).not.toContain('relative_path'); expect(serialized).not.toContain('PRIVATE_SOURCE_BODY')
    test.database.close()
  })

  it('migrates the audit table while retaining STEP-20 Evidence data', async () => {
    const test = await fixture(); const source = await artifact(test, 'migration-source.md'); const target = await artifact(test, 'migration-target.md')
    const relation = test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'references' })
    expect(test.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provenance_audit_records'").get()).toEqual({ name: 'provenance_audit_records' })
    expect(test.database.getArtifactEvidenceLink(relation.id)).toBeDefined()
    expect(test.database.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(test.database.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    test.database.close()
  })

  it('declares token-protected Graph, Audit and Export routes', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8')
    expect(source).toContain("projectProvenanceMatch[2] === 'provenance'")
    expect(source).toContain("action === 'provenance'")
    expect(source).toContain("action === 'audit'")
    expect(source).toContain('provenance\\/export')
    expect(source).toContain('TOKEN_REQUIRED')
  })
})
