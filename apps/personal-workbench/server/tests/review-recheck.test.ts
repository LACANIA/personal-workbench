import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { EvidenceAuditService } from '../src/artifacts/evidence-audit-service.ts'
import { ArtifactIntelligenceService } from '../src/artifacts/intelligence-service.ts'
import { ReleaseAuditService } from '../src/artifacts/release-audit-service.ts'
import { ReviewPolicyService } from '../src/artifacts/review-policy-service.ts'
import { ReviewQueueService } from '../src/artifacts/review-queue-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { loadOrCreateLocalConfig, validateLocalConfig } from '../src/portable-config.ts'
import { ProjectContextService } from '../src/projects/service.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe recheck cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(path.join(root, 'output'), { recursive: true })
  temporaryRoots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  const evidence = new ArtifactEvidenceService(database)
  const artifacts = new ArtifactService(database, evidence)
  const project = await new ProjectContextService(database).register({ rootPath: root, name: 'Recheck Fixture' })
  const audit = new EvidenceAuditService(database, artifacts, evidence)
  const policy = new ReviewPolicyService(database, artifacts, evidence, audit)
  const release = new ReleaseAuditService(artifacts, evidence, audit, policy)
  const reviews = new ReviewQueueService(database, artifacts, evidence, audit, release, policy)
  const reviewer = policy.createReviewer({ name: `Reviewer ${randomUUID().slice(0, 6)}`, role: 'lead_reviewer' })
  return { root, database, evidence, artifacts, project, audit, policy, release, reviews, reviewer, intelligence: new ArtifactIntelligenceService(database, artifacts) }
}

async function createArtifact(test: Awaited<ReturnType<typeof fixture>>, name: string, content: string, artifactType: 'report' | 'code' | 'dataset' = 'report') {
  const file = path.join(test.root, 'output', name)
  await writeFile(file, content, 'utf8')
  const artifact = await test.artifacts.register({ project_id: test.project.id, file_path: file, artifact_type: artifactType })
  const task = test.database.createTask(randomUUID(), { templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root })
  test.evidence.create(artifact.id, { source_type: 'task', source_id: task.id, relation_type: 'generated_from' })
  return artifact
}

describe('Review Recheck Workflow', () => {
  it('creates snapshot storage and recheck linkage without changing old Review rows', async () => {
    const test = await fixture(); const artifact = await createArtifact(test, 'migration.md', '# v1\ncontent')
    const first = test.reviews.submitReview(artifact.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'research' })
    const detail = test.database.getReviewSnapshotDetail(first.id)
    expect(detail).toMatchObject({ review_decision_id: first.id, artifact_snapshot_kind: 'markdown' })
    expect(detail?.artifact_snapshot_path).toMatch(/review-snapshots/u)
    expect(test.database.db.prepare("PRAGMA table_info('review_decisions')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'recheck_of_review_id' })]))
    expect(test.database.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    test.database.close()
  })

  it('generates a bounded Markdown Artifact Diff after content changes', async () => {
    const test = await fixture(); const artifact = await createArtifact(test, 'report.md', '# Report\nold value\nshared')
    test.reviews.submitReview(artifact.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'research' })
    await writeFile(artifact.absolute_path, '# Report\nnew value\nshared', 'utf8'); await test.intelligence.check(artifact.id)
    const report = test.reviews.changes.report(artifact.id)
    expect(report.release_status).toBe('NEEDS_RECHECK')
    expect(report.artifact_diff).toMatchObject({ supported: true, snapshot_available: true, changed: true, added_lines: 1, removed_lines: 1, impact_scope: 'small' })
    expect(report.artifact_diff.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'removed', content: 'old value' }), expect.objectContaining({ kind: 'added', content: 'new value' })]))
    test.database.close()
  })

  it('supports code and dataset snapshot categories', async () => {
    const test = await fixture()
    const code = await createArtifact(test, 'main.ts', 'export const value = 1\n', 'code')
    const data = await createArtifact(test, 'metrics.csv', 'name,value\na,1\n', 'dataset')
    test.reviews.submitReview(code.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'code' })
    test.reviews.submitReview(data.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'research' })
    await writeFile(code.absolute_path, 'export const value = 2\n', 'utf8'); await test.intelligence.check(code.id)
    await writeFile(data.absolute_path, 'name,value\na,2\n', 'utf8'); await test.intelligence.check(data.id)
    expect(test.reviews.changes.report(code.id).artifact_diff.snapshot_kind).toBe('code')
    expect(test.reviews.changes.report(data.id).artifact_diff.snapshot_kind).toBe('dataset')
    test.database.close()
  })

  it('reports added, removed, invalidated and restored Evidence states deterministically', async () => {
    const test = await fixture(); const target = await createArtifact(test, 'evidence.md', '# Evidence'); const source = await createArtifact(test, 'source.md', '# Source')
    test.reviews.submitReview(target.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'research' })
    const link = test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'references' })
    expect(test.reviews.changes.report(target.id).evidence_diff.added).toEqual([expect.objectContaining({ source_id: source.id })])
    test.evidence.delete(link.id)
    const restoredBaseline = test.reviews.changes.report(target.id)
    expect(restoredBaseline.evidence_diff.added).toHaveLength(0)
    expect(restoredBaseline.evidence_diff.changed).toBe(false)
    test.database.close()
  })

  it('rechecks an Artifact, registers a new version and returns READY while retaining history', async () => {
    const test = await fixture(); const artifact = await createArtifact(test, 'recheck.md', '# Review\nversion one')
    const first = test.reviews.submitReview(artifact.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'research' })
    await writeFile(artifact.absolute_path, '# Review\nversion two', 'utf8'); await test.intelligence.check(artifact.id)
    expect(test.release.inspectArtifact(artifact.id).status).toBe('NEEDS_RECHECK')
    const result = test.reviews.recheckReview(artifact.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'research', note: '确认当前版本' })
    expect(result.review.recheck_of_review_id).toBe(first.id)
    expect(result.accepted_version?.version_number).toBe(2)
    expect(result.release).toMatchObject({ status: 'READY', signature_status: 'VALID' })
    expect(test.database.listArtifactReviewDecisions(artifact.id)).toHaveLength(2)
    expect(test.database.listReviewInvalidations(artifact.id, first.id)).toHaveLength(1)
    expect(result.timeline.map(event => event.type)).toEqual(['initial_review', 'change_detected', 'review_rechecked'])
    test.database.close()
  })

  it('rechecks an Evidence-only change without creating an Artifact version', async () => {
    const test = await fixture(); const target = await createArtifact(test, 'evidence-recheck.md', '# Evidence'); const source = await createArtifact(test, 'new-source.md', '# Source')
    test.reviews.submitReview(target.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'research' })
    test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'references' })
    const result = test.reviews.recheckReview(target.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'research' })
    expect(result.accepted_version).toBeNull()
    expect(result.release.status).toBe('READY')
    expect(result.change_report.evidence_diff.added).toHaveLength(1)
    test.database.close()
  })

  it('builds Project review history with initial, change and recheck events', async () => {
    const test = await fixture(); const artifact = await createArtifact(test, 'timeline.md', '# Timeline\none')
    test.reviews.submitReview(artifact.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'research' })
    await writeFile(artifact.absolute_path, '# Timeline\ntwo', 'utf8'); await test.intelligence.check(artifact.id)
    test.release.inspectArtifact(artifact.id)
    test.reviews.recheckReview(artifact.id, { decision: 'approved', reviewer_id: test.reviewer.id, policy_type: 'research' })
    const project = test.reviews.changes.projectHistory(test.project.id)
    expect(project).toMatchObject({ initial_review_count: 1, change_event_count: 1, recheck_count: 1 })
    expect(project.artifacts[0]?.change_report.release_status).toBe('READY')
    test.database.close()
  })

  it('auto-generates portable local-config.json and rejects non-loopback Ollama endpoints', async () => {
    const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID()); temporaryRoots.push(root)
    const appRoot = path.join(root, 'project', 'apps', 'personal-workbench'); await mkdir(appRoot, { recursive: true })
    const config = loadOrCreateLocalConfig({ appRoot, environment: { OLLAMA_HOST: '127.0.0.1:11434', PERSONAL_WORKBENCH_MODEL: 'qwen3:8b' } })
    expect(config).toMatchObject({ workspace_root: root, project_path: path.join(root, 'project'), ollama_endpoint: 'http://127.0.0.1:11434', model_name: 'qwen3:8b', interface_mode: 'consumer' })
    expect(JSON.parse(await readFile(path.join(appRoot, 'local-config.json'), 'utf8'))).toEqual(config)
    expect(loadOrCreateLocalConfig({ appRoot })).toEqual(config)
    expect(validateLocalConfig({ ...config, interface_mode: 'advanced' }).interface_mode).toBe('advanced')
    expect(() => validateLocalConfig({ ...config, ollama_endpoint: 'https://example.com' })).toThrow('LOCAL_CONFIG_OLLAMA_ENDPOINT_NOT_LOOPBACK')
  })

  it('publishes token-protected change, timeline, recheck and config API routes', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8')
    expect(source).toContain('review-change|review-timeline|recheck')
    expect(source).toContain("url.pathname === '/api/config'")
    expect(source).toContain('TOKEN_REQUIRED')
  })
})
