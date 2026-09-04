import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { EvidenceAuditService } from '../src/artifacts/evidence-audit-service.ts'
import { ArtifactIntelligenceService } from '../src/artifacts/intelligence-service.ts'
import { ReleaseAuditService } from '../src/artifacts/release-audit-service.ts'
import { ReviewQueueService } from '../src/artifacts/review-queue-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { ProjectContextService } from '../src/projects/service.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe review queue cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(path.join(root, 'output'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"review-queue-fixture"}', 'utf8')
  temporaryRoots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  const evidence = new ArtifactEvidenceService(database)
  const artifacts = new ArtifactService(database, evidence)
  const projects = new ProjectContextService(database)
  const project = await projects.register({ rootPath: root, name: 'Review Queue Fixture' })
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
    intelligence: new ArtifactIntelligenceService(database, artifacts),
    reviews: new ReviewQueueService(database, artifacts, evidence, audit, release),
  }
}

async function artifact(test: Awaited<ReturnType<typeof fixture>>, name: string) {
  const file = path.join(test.root, 'output', name)
  await writeFile(file, `# ${name}`, 'utf8')
  return test.artifacts.register({ project_id: test.project.id, file_path: file, artifact_type: 'report' })
}

async function validTaskEvidence(test: Awaited<ReturnType<typeof fixture>>, artifactId: string): Promise<void> {
  const task = test.database.createTask(randomUUID(), {
    templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root,
  })
  test.evidence.create(artifactId, { source_type: 'task', source_id: task.id, relation_type: 'generated_from' })
}

describe('Review Queue and Human Approval Gate', () => {
  it('creates the Review table without changing existing Artifact rows', async () => {
    const test = await fixture(); const target = await artifact(test, 'migration.md'); const before = test.artifacts.get(target.id)
    expect(test.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_decisions'").get()).toEqual({ name: 'review_decisions' })
    test.reviews.submitReview(target.id, { decision: 'pending', reviewer: 'tester', note: '等待人工判断' })
    expect(test.artifacts.get(target.id)).toEqual(before)
    expect(test.database.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    test.database.close()
  })

  it('submits Review records and returns ordered history', async () => {
    const test = await fixture(); const target = await artifact(test, 'history.md')
    test.reviews.submitReview(target.id, { decision: 'pending', reviewer: 'reviewer-a', note: '首次检查' })
    test.reviews.submitReview(target.id, { decision: 'needs_revision', reviewer: 'reviewer-b', note: '补充来源' })
    const history = test.reviews.getReviewHistory(target.id)
    expect(history).toMatchObject({ current_decision: 'needs_revision', count: 2 })
    expect(history.history.map(row => row.decision)).toEqual(['needs_revision', 'pending'])
    test.database.close()
  })

  it('rejects automatic-looking or malformed Review input', async () => {
    const test = await fixture(); const target = await artifact(test, 'validation.md')
    expect(() => test.reviews.submitReview(target.id, { decision: 'approved', reviewer: '', note: '' })).toThrow('INVALID_REVIEW_REVIEWER')
    expect(() => test.reviews.submitReview(target.id, { decision: 'unknown' as 'approved', reviewer: 'tester' })).toThrow('INVALID_REVIEW_DECISION')
    expect(() => test.reviews.submitReview('missing-artifact', { decision: 'approved', reviewer: 'tester' })).toThrow('ARTIFACT_NOT_FOUND')
    test.database.close()
  })

  it('collects warning, broken, missing and human-review items', async () => {
    const test = await fixture()
    const healthyPending = await artifact(test, 'healthy-pending.md'); await validTaskEvidence(test, healthyPending.id)
    const missing = await artifact(test, 'missing.md')
    const warning = await artifact(test, 'warning.md'); await validTaskEvidence(test, warning.id); await writeFile(warning.absolute_path, '# changed', 'utf8'); await test.intelligence.check(warning.id)
    const source = await artifact(test, 'deleted-source.md')
    const broken = await artifact(test, 'broken.md'); test.evidence.create(broken.id, { source_type: 'artifact', source_id: source.id, relation_type: 'references' }); test.database.deleteArtifact(source.id)
    const queue = test.reviews.getPendingReviews(test.project.id)
    expect(queue.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifact_id: healthyPending.id, severity: 'needs_review', current_decision: 'pending' }),
      expect.objectContaining({ artifact_id: missing.id, severity: 'missing', evidence_status: 'missing' }),
      expect.objectContaining({ artifact_id: warning.id, severity: 'warning', audit_status: 'warning' }),
      expect.objectContaining({ artifact_id: broken.id, severity: 'broken', evidence_status: 'broken' }),
    ]))
    test.database.close()
  })

  it('enforces READY, NEEDS_REVIEW and REJECTED using the latest human decision', async () => {
    const test = await fixture()
    const healthy = await artifact(test, 'healthy.md'); await validTaskEvidence(test, healthy.id); test.reviews.submitReview(healthy.id, { decision: 'approved', reviewer: 'tester' })
    const pending = await artifact(test, 'pending.md'); await validTaskEvidence(test, pending.id); test.reviews.submitReview(pending.id, { decision: 'pending', reviewer: 'tester' })
    const rejected = await artifact(test, 'rejected.md'); await validTaskEvidence(test, rejected.id); test.reviews.submitReview(rejected.id, { decision: 'rejected', reviewer: 'tester' })
    expect(test.release.inspectArtifact(healthy.id)).toMatchObject({ status: 'READY', review_decision: 'approved' })
    expect(test.release.inspectArtifact(pending.id)).toMatchObject({ status: 'NEEDS_REVIEW', review_decision: 'pending' })
    expect(test.release.inspectArtifact(rejected.id)).toMatchObject({ status: 'REJECTED', review_decision: 'rejected' })
    test.database.close()
  })

  it('summarizes the latest Review decision for every project Artifact', async () => {
    const test = await fixture(); const approved = await artifact(test, 'approved.md'); const revision = await artifact(test, 'revision.md'); await artifact(test, 'pending.md')
    test.reviews.submitReview(approved.id, { decision: 'approved', reviewer: 'tester' })
    test.reviews.submitReview(revision.id, { decision: 'needs_revision', reviewer: 'tester' })
    expect(test.reviews.getReviewSummary(test.project.id)).toMatchObject({ artifact_count: 3, approved: 1, needs_revision: 1, pending: 1, rejected: 0 })
    test.database.close()
  })

  it('keeps Project review queues isolated', async () => {
    const test = await fixture(); const first = await artifact(test, 'first.md')
    const secondRoot = path.join(test.root, 'second'); await mkdir(path.join(secondRoot, 'output'), { recursive: true }); await writeFile(path.join(secondRoot, 'package.json'), '{}', 'utf8')
    const secondProject = await test.projects.register({ rootPath: secondRoot, name: 'Second Review Project' })
    const secondFile = path.join(secondRoot, 'output', 'second.md'); await writeFile(secondFile, '# second', 'utf8')
    const second = await test.artifacts.register({ project_id: secondProject.id, file_path: secondFile })
    expect(test.reviews.getPendingReviews(test.project.id).reviews.map(item => item.artifact_id)).toEqual([first.id])
    expect(test.reviews.getPendingReviews(secondProject.id).reviews.map(item => item.artifact_id)).toEqual([second.id])
    test.database.close()
  })

  it('declares token-protected Review APIs and performs no Artifact update in the Review service', async () => {
    const apiSource = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8')
    const serviceSource = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'artifacts', 'review-queue-service.ts'), 'utf8')
    expect(apiSource).toContain('review-summary')
    expect(apiSource).toContain('reviews\\/history')
    expect(apiSource).toContain("action === 'review'")
    expect(apiSource).toContain('TOKEN_REQUIRED')
    expect(serviceSource).not.toMatch(/UPDATE\s+artifacts|DELETE\s+FROM\s+artifacts|INSERT\s+INTO\s+artifacts/iu)
  })
})
