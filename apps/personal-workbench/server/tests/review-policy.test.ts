import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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
import { ProjectContextService } from '../src/projects/service.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe review policy cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(path.join(root, 'output'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"review-policy-fixture"}', 'utf8')
  temporaryRoots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  const evidence = new ArtifactEvidenceService(database)
  const artifacts = new ArtifactService(database, evidence)
  const projects = new ProjectContextService(database)
  const project = await projects.register({ rootPath: root, name: 'Review Policy Fixture' })
  const audit = new EvidenceAuditService(database, artifacts, evidence)
  const policy = new ReviewPolicyService(database, artifacts, evidence, audit)
  const release = new ReleaseAuditService(artifacts, evidence, audit, policy)
  return {
    root, database, evidence, artifacts, projects, project, audit, policy, release,
    reviews: new ReviewQueueService(database, artifacts, evidence, audit, release, policy),
    intelligence: new ArtifactIntelligenceService(database, artifacts),
  }
}

async function artifact(test: Awaited<ReturnType<typeof fixture>>, name: string, artifactType: 'report' | 'code' = 'report') {
  const file = path.join(test.root, 'output', name)
  await writeFile(file, `# ${name}\ninitial`, 'utf8')
  const record = await test.artifacts.register({ project_id: test.project.id, file_path: file, artifact_type: artifactType })
  const task = test.database.createTask(randomUUID(), { templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root })
  test.evidence.create(record.id, { source_type: 'task', source_id: task.id, relation_type: 'generated_from' })
  return record
}

describe('Reviewer Identity, Review Policy and Signature', () => {
  it('migrates identity, policy and invalidation tables while retaining legacy Review rows', async () => {
    const test = await fixture(); const target = await artifact(test, 'legacy.md')
    test.database.createReviewDecision({ id: randomUUID(), artifact_id: target.id, decision: 'pending', reviewer: 'legacy-user', note: '', created_at: new Date().toISOString() } as never)
    const legacy = test.database.getLatestArtifactReviewDecision(target.id)!
    expect(legacy).toMatchObject({ reviewer: 'legacy-user', reviewer_id: null, artifact_hash: null, evidence_hash: null, policy_version: null })
    for (const table of ['reviewer_profiles', 'review_policies', 'review_invalidations']) {
      expect(test.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toEqual({ name: table })
    }
    expect(test.database.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    test.database.close()
  })

  it('creates local Reviewer identities and rejects duplicate names with conflicting roles', async () => {
    const test = await fixture()
    const reviewer = test.policy.createReviewer({ name: '研究审核人', role: 'research_reviewer' })
    expect(reviewer).toMatchObject({ name: '研究审核人', role: 'research_reviewer' })
    expect(test.policy.createReviewer({ name: '研究审核人', role: 'research_reviewer' }).id).toBe(reviewer.id)
    expect(() => test.policy.createReviewer({ name: '研究审核人', role: 'code_reviewer' })).toThrow('REVIEWER_NAME_CONFLICT')
    test.database.close()
  })

  it('provides versioned research, code and knowledge policies', async () => {
    const test = await fixture()
    expect(test.policy.listPolicies().map(item => `${item.policy_type}@${item.version}`)).toEqual(['code@1.0.0', 'knowledge@1.0.0', 'research@1.0.0'])
    expect(test.policy.listPolicies().every(item => item.active)).toBe(true)
    test.database.close()
  })

  it('binds an approved Review to Reviewer, Artifact, Evidence and Policy snapshots', async () => {
    const test = await fixture(); const target = await artifact(test, 'signed.md')
    const reviewer = test.policy.createReviewer({ name: 'Signer', role: 'research_reviewer' })
    const review = test.reviews.submitReview(target.id, { decision: 'approved', reviewer_id: reviewer.id, policy_type: 'research', note: '人工确认' })
    expect(review).toMatchObject({ reviewer_id: reviewer.id, policy_type: 'research', policy_version: '1.0.0' })
    expect(review.artifact_hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(review.evidence_hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(test.policy.evaluateSignature(target.id)).toMatchObject({ status: 'VALID', needs_recheck: false, policy_passed: true })
    expect(test.release.inspectArtifact(target.id)).toMatchObject({ status: 'READY', signature_status: 'VALID' })
    test.database.close()
  })

  it('changes an approved Artifact to NEEDS_RECHECK and records one hash invalidation', async () => {
    const test = await fixture(); const target = await artifact(test, 'artifact-a.md')
    const reviewer = test.policy.createReviewer({ name: 'Artifact A Reviewer', role: 'research_reviewer' })
    test.reviews.submitReview(target.id, { decision: 'approved', reviewer_id: reviewer.id, policy_type: 'research' })
    await writeFile(target.absolute_path, '# artifact-a\nchanged', 'utf8')
    await test.intelligence.check(target.id)
    const release = test.release.inspectArtifact(target.id)
    expect(release).toMatchObject({ status: 'NEEDS_RECHECK', signature_status: 'INVALID' })
    expect(release.invalidations).toEqual([expect.objectContaining({ reason: 'artifact_hash_changed' })])
    expect(test.release.inspectArtifact(target.id).invalidations).toHaveLength(1)
    test.database.close()
  })

  it('invalidates an approved signature after the Evidence relation set changes', async () => {
    const test = await fixture(); const target = await artifact(test, 'evidence-change.md'); const source = await artifact(test, 'extra-source.md')
    const reviewer = test.policy.createReviewer({ name: 'Evidence Reviewer', role: 'research_reviewer' })
    test.reviews.submitReview(target.id, { decision: 'approved', reviewer_id: reviewer.id, policy_type: 'research' })
    test.evidence.create(target.id, { source_type: 'artifact', source_id: source.id, relation_type: 'references' })
    expect(test.release.inspectArtifact(target.id)).toMatchObject({ status: 'NEEDS_RECHECK', invalidations: [expect.objectContaining({ reason: 'evidence_hash_changed' })] })
    test.database.close()
  })

  it('marks a research Artifact READY when identity, policy, signature and evidence all pass', async () => {
    const test = await fixture(); const target = await artifact(test, 'artifact-b.md')
    const reviewer = test.policy.createReviewer({ name: 'Artifact B Reviewer', role: 'research_reviewer' })
    test.reviews.submitReview(target.id, { decision: 'approved', reviewer_id: reviewer.id, policy_type: 'research' })
    const result = test.release.inspectArtifact(target.id)
    expect(result.status).toBe('READY')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'policy_pass', passed: true }),
      expect.objectContaining({ id: 'signature_valid', passed: true }),
    ]))
    test.database.close()
  })

  it('keeps a policy mismatch at NEEDS_REVIEW without changing the Artifact', async () => {
    const test = await fixture(); const target = await artifact(test, 'artifact-c.ts', 'code'); const before = test.artifacts.get(target.id)
    const reviewer = test.policy.createReviewer({ name: 'Artifact C Reviewer', role: 'research_reviewer' })
    test.reviews.submitReview(target.id, { decision: 'approved', reviewer_id: reviewer.id, policy_type: 'research' })
    expect(test.release.inspectArtifact(target.id)).toMatchObject({ status: 'NEEDS_REVIEW', signature_status: 'INVALID', checks: expect.arrayContaining([expect.objectContaining({ id: 'policy_pass', passed: false })]) })
    expect(test.artifacts.get(target.id)).toEqual(before)
    test.database.close()
  })

  it('does not approve automatically when a Reviewer profile is created', async () => {
    const test = await fixture(); const target = await artifact(test, 'manual-only.md')
    test.policy.createReviewer({ name: 'Manual Only', role: 'lead_reviewer' })
    expect(test.database.listArtifactReviewDecisions(target.id)).toHaveLength(0)
    expect(test.release.inspectArtifact(target.id).status).toBe('NEEDS_REVIEW')
    test.database.close()
  })

  it('keeps Review APIs behind the existing token gate and exposes no remote identity client', async () => {
    const test = await fixture()
    const serviceSource = await import('node:fs/promises').then(fs => fs.readFile(path.join(PATHS.appRoot, 'server', 'src', 'artifacts', 'review-policy-service.ts'), 'utf8'))
    const apiSource = await import('node:fs/promises').then(fs => fs.readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8'))
    expect(apiSource).toContain("url.pathname === '/api/reviewers'")
    expect(apiSource).toContain('TOKEN_REQUIRED')
    expect(serviceSource).not.toMatch(/https?:\/\//u)
    expect(serviceSource).not.toMatch(/fetch\s*\(/u)
    test.database.close()
  })
})
