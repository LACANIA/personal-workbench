import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { EvidenceAuditService } from '../src/artifacts/evidence-audit-service.ts'
import { EvidenceHealthService } from '../src/artifacts/evidence-health-service.ts'
import { ProvenanceGraphService } from '../src/artifacts/provenance-graph-service.ts'
import { ReleaseAuditService } from '../src/artifacts/release-audit-service.ts'
import { ReviewQueueService } from '../src/artifacts/review-queue-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { ProjectContextService } from '../src/projects/service.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe evidence dashboard cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(name = 'Evidence Dashboard Fixture') {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(path.join(root, 'output'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"evidence-dashboard-fixture"}', 'utf8')
  temporaryRoots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  const evidence = new ArtifactEvidenceService(database)
  const artifacts = new ArtifactService(database, evidence)
  const projects = new ProjectContextService(database)
  const project = await projects.register({ rootPath: root, name })
  const audit = new EvidenceAuditService(database, artifacts, evidence)
  const release = new ReleaseAuditService(artifacts, evidence, audit)
  return {
    root,
    database,
    evidence,
    artifacts,
    projects,
    project,
    audit,
    release,
    reviews: new ReviewQueueService(database, artifacts, evidence, audit, release),
    health: new EvidenceHealthService(database, audit, release),
    graph: new ProvenanceGraphService(database, evidence),
  }
}

async function artifact(test: Awaited<ReturnType<typeof fixture>>, name: string) {
  const file = path.join(test.root, 'output', name)
  await writeFile(file, `# ${name}`, 'utf8')
  return test.artifacts.register({ project_id: test.project.id, file_path: file, artifact_type: 'report' })
}

describe('Evidence Intelligence Dashboard', () => {
  it('calculates coverage and healthy, warning and broken totals without persisting audits', async () => {
    const test = await fixture()
    const task = test.database.createTask(randomUUID(), { templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root })
    const healthy = await artifact(test, 'healthy.md')
    test.evidence.create(healthy.id, { source_type: 'task', source_id: task.id, relation_type: 'generated_from' })
    await artifact(test, 'warning.md')
    const missingSource = await artifact(test, 'missing-source.md')
    const broken = await artifact(test, 'broken.md')
    test.evidence.create(broken.id, { source_type: 'artifact', source_id: missingSource.id, relation_type: 'references' })
    test.database.deleteArtifact(missingSource.id)

    const health = test.health.getProjectEvidenceHealth(test.project.id)
    expect(health).toMatchObject({ artifact_count: 3, covered_count: 2, coverage: 2 / 3 })
    expect(health.health_summary).toEqual({ healthy: 1, warning: 1, broken: 1 })
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifact_id: broken.id, severity: 'broken', code: 'EVIDENCE_SOURCE_UNAVAILABLE' }),
      expect.objectContaining({ severity: 'missing', code: 'EVIDENCE_MISSING' }),
    ]))
    expect(test.database.listProjectProvenanceAudits(test.project.id)).toHaveLength(0)
    test.database.close()
  })

  it('returns recent persisted Audit records without creating cache tables', async () => {
    const test = await fixture(); const source = await artifact(test, 'source.md'); const target = await artifact(test, 'target.md')
    test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'verified_by' })
    const audit = test.audit.auditArtifact(target.id)
    const health = test.health.getProjectEvidenceHealth(test.project.id)
    expect(health.recent_audits).toContainEqual(expect.objectContaining({ id: audit.audit_id, artifact_id: target.id, artifact_name: 'target.md' }))
    expect(test.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evidence_health_snapshots'").get()).toBeUndefined()
    test.database.close()
  })

  it('requires an approved human Review in addition to the structural checks', async () => {
    const test = await fixture(); const source = await artifact(test, 'release-source.md'); const ready = await artifact(test, 'release-ready.md'); const review = await artifact(test, 'release-review.md')
    test.evidence.create(ready.id, { source_type: 'artifact', source_id: source.id, relation_type: 'verified_by' })
    expect(test.release.inspectArtifact(ready.id)).toMatchObject({ status: 'NEEDS_REVIEW', review_decision: 'pending', checks: expect.arrayContaining([expect.objectContaining({ id: 'review_approved', passed: false })]) })
    test.reviews.submitReview(ready.id, { decision: 'approved', reviewer: 'tester', note: '人工验收通过' })
    expect(test.release.inspectArtifact(ready.id)).toMatchObject({ status: 'READY', review_decision: 'approved', checks: expect.arrayContaining([expect.objectContaining({ id: 'source_available', passed: true }), expect.objectContaining({ id: 'review_approved', passed: true })]) })
    expect(test.release.inspectArtifact(review.id)).toMatchObject({ status: 'NEEDS_REVIEW', checks: expect.arrayContaining([expect.objectContaining({ id: 'evidence_present', passed: false })]) })
    test.database.close()
  })

  it('keeps project health isolated to the requested Project Context', async () => {
    const test = await fixture(); await artifact(test, 'first.md')
    const otherRoot = path.join(test.root, 'other'); await mkdir(path.join(otherRoot, 'output'), { recursive: true }); await writeFile(path.join(otherRoot, 'package.json'), '{}', 'utf8')
    const other = await test.projects.register({ rootPath: otherRoot, name: 'Other Project' })
    const otherFile = path.join(otherRoot, 'output', 'other.md'); await writeFile(otherFile, '# Other', 'utf8')
    await test.artifacts.register({ project_id: other.id, file_path: otherFile })
    expect(test.health.getProjectEvidenceHealth(test.project.id)).toMatchObject({ project_id: test.project.id, artifact_count: 1 })
    expect(test.health.getProjectEvidenceHealth(other.id)).toMatchObject({ project_id: other.id, artifact_count: 1 })
    test.database.close()
  })
})

describe('Provenance Graph depth', () => {
  it('expands Artifact relations at depth 1, 2 and 3', async () => {
    const test = await fixture(); const a = await artifact(test, 'a.md'); const b = await artifact(test, 'b.md'); const c = await artifact(test, 'c.md'); const d = await artifact(test, 'd.md')
    test.evidence.create(a.id, { source_type: 'artifact', source_id: b.id, relation_type: 'derived_from' })
    test.evidence.create(b.id, { source_type: 'artifact', source_id: c.id, relation_type: 'derived_from' })
    test.evidence.create(c.id, { source_type: 'artifact', source_id: d.id, relation_type: 'derived_from' })
    expect(test.graph.artifact(a.id, 1)).toMatchObject({ depth: 1, nodes: expect.arrayContaining([expect.objectContaining({ id: `artifact:${b.id}` })]) })
    expect(test.graph.artifact(a.id, 1).nodes.some(node => node.id === `artifact:${c.id}`)).toBe(false)
    expect(test.graph.artifact(a.id, 2).nodes.some(node => node.id === `artifact:${c.id}`)).toBe(true)
    expect(test.graph.artifact(a.id, 3).nodes.some(node => node.id === `artifact:${d.id}`)).toBe(true)
    test.database.close()
  })

  it('uses a visited set to stop cyclic Artifact relations', async () => {
    const test = await fixture(); const a = await artifact(test, 'cycle-a.md'); const b = await artifact(test, 'cycle-b.md')
    test.evidence.create(a.id, { source_type: 'artifact', source_id: b.id, relation_type: 'references' })
    test.evidence.create(b.id, { source_type: 'artifact', source_id: a.id, relation_type: 'references' })
    const graph = test.graph.artifact(a.id, 3)
    expect(graph.nodes.filter(node => node.type === 'artifact')).toHaveLength(2)
    expect(graph.edges).toHaveLength(2)
    test.database.close()
  })

  it('rejects unsupported depth values', async () => {
    const test = await fixture(); const target = await artifact(test, 'depth.md')
    expect(() => test.graph.artifact(target.id, 0)).toThrow('INVALID_PROVENANCE_DEPTH')
    expect(() => test.graph.artifact(target.id, 4)).toThrow('INVALID_PROVENANCE_DEPTH')
    expect(() => test.graph.artifact(target.id, 1.5)).toThrow('INVALID_PROVENANCE_DEPTH')
    test.database.close()
  })
})

describe('Evidence Dashboard API boundary', () => {
  it('declares the protected health and bounded depth routes', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8')
    expect(source).toContain('evidence-health')
    expect(source).toContain("url.searchParams.get('depth')")
    expect(source).toContain('TOKEN_REQUIRED')
    expect(source).toContain('LOOPBACK_ONLY')
  })
})
