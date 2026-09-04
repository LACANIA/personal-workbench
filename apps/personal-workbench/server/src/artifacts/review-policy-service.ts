import { randomUUID } from 'node:crypto'
import {
  REVIEW_POLICY_TYPES,
  REVIEWER_ROLES,
  type ArtifactEvidenceBundle,
  type ArtifactRecord,
  type ReviewPolicy,
  type ReviewPolicyType,
  type ReviewerProfile,
  type ReviewerRole,
  type ReviewSignatureEvaluation,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { ArtifactEvidenceService } from './evidence-service.ts'
import { EvidenceAuditService } from './evidence-audit-service.ts'
import { ArtifactService } from './service.ts'
import { reviewEvidenceHash, reviewEvidenceSnapshot } from './review-snapshot.ts'

const SHA256 = /^[0-9a-f]{64}$/u

function requiredText(value: unknown, code: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(code)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum || normalized.includes('\0')) throw new Error(code)
  return normalized
}

function actualArtifactHash(artifact: ArtifactRecord): string {
  const observed = artifact.metadata.current_hash
  return typeof observed === 'string' && SHA256.test(observed.toLowerCase()) ? observed.toLowerCase() : artifact.sha256.toLowerCase()
}

export class ReviewPolicyService {
  constructor(
    readonly database: WorkbenchDatabase,
    readonly artifacts: ArtifactService,
    readonly evidence: ArtifactEvidenceService,
    readonly audit: EvidenceAuditService,
  ) {}

  createReviewer(input: { name: unknown; role: unknown }): ReviewerProfile {
    const name = requiredText(input.name, 'INVALID_REVIEWER_NAME', 128)
    if (typeof input.role !== 'string' || !REVIEWER_ROLES.includes(input.role as ReviewerRole)) throw new Error('INVALID_REVIEWER_ROLE')
    const existing = this.database.findReviewerProfileByName(name)
    if (existing !== undefined) {
      if (existing.role !== input.role) throw new Error('REVIEWER_NAME_CONFLICT')
      return existing
    }
    const timestamp = new Date().toISOString()
    return this.database.createReviewerProfile({
      id: randomUUID(),
      name,
      role: input.role as ReviewerRole,
      created_at: timestamp,
      updated_at: timestamp,
    })
  }

  listReviewers(): ReviewerProfile[] { return this.database.listReviewerProfiles() }

  listPolicies(): ReviewPolicy[] { return this.database.listReviewPolicies() }

  policyTypeForArtifact(artifact: ArtifactRecord): ReviewPolicyType {
    if (['document', 'report', 'dataset', 'analysis'].includes(artifact.artifact_type)) return 'research'
    if (['code', 'log'].includes(artifact.artifact_type)) return 'code'
    return 'knowledge'
  }

  resolveReviewer(input: { reviewer_id?: unknown; reviewer?: unknown; role?: unknown }): ReviewerProfile {
    if (typeof input.reviewer_id === 'string' && input.reviewer_id.trim().length > 0) {
      const reviewer = this.database.getReviewerProfile(input.reviewer_id.trim())
      if (reviewer === undefined) throw new Error('REVIEWER_PROFILE_NOT_FOUND')
      return reviewer
    }
    if (typeof input.reviewer !== 'string' || input.reviewer.trim().length === 0) throw new Error('INVALID_REVIEW_REVIEWER')
    return this.createReviewer({ name: input.reviewer, role: input.role ?? 'reviewer' })
  }

  resolvePolicy(artifact: ArtifactRecord, policyTypeValue?: unknown): ReviewPolicy {
    const selected = policyTypeValue === undefined ? this.policyTypeForArtifact(artifact) : policyTypeValue
    if (typeof selected !== 'string' || !REVIEW_POLICY_TYPES.includes(selected as ReviewPolicyType)) throw new Error('INVALID_REVIEW_POLICY_TYPE')
    const policy = this.database.getReviewPolicy(selected as ReviewPolicyType)
    if (policy === undefined) throw new Error('REVIEW_POLICY_NOT_FOUND')
    return policy
  }

  evidenceHash(bundle: ArtifactEvidenceBundle): string {
    return reviewEvidenceHash(reviewEvidenceSnapshot(bundle))
  }

  signatureSnapshot(artifactId: string, reviewer: ReviewerProfile, policy: ReviewPolicy): {
    artifact_hash: string
    evidence_hash: string
    policy_passed: boolean
  } {
    const artifact = this.artifacts.get(artifactId)
    const bundle = this.evidence.forArtifact(artifact.id)
    return {
      artifact_hash: actualArtifactHash(artifact),
      evidence_hash: this.evidenceHash(bundle),
      policy_passed: this.policyPasses(artifact, reviewer, policy, bundle),
    }
  }

  evaluateSignature(artifactId: string, checkedAt = new Date().toISOString()): ReviewSignatureEvaluation {
    const artifact = this.artifacts.get(artifactId)
    const latest = this.database.getLatestArtifactReviewDecision(artifact.id)
    const bundle = this.evidence.forArtifact(artifact.id)
    const currentArtifactHash = actualArtifactHash(artifact)
    const currentEvidenceHash = this.evidenceHash(bundle)
    if (latest === undefined) {
      return {
        artifact_id: artifact.id,
        review_decision_id: null,
        status: 'INVALID',
        needs_recheck: false,
        reasons: ['REVIEW_NOT_FOUND'],
        artifact_hash: currentArtifactHash,
        evidence_hash: currentEvidenceHash,
        policy_type: null,
        policy_version: null,
        reviewer: null,
        policy: null,
        policy_passed: false,
        invalidations: [],
        checked_at: checkedAt,
      }
    }

    const reviewer = latest.reviewer_id === null ? null : this.database.getReviewerProfile(latest.reviewer_id) ?? null
    const policy = latest.policy_type === null || latest.policy_version === null
      ? null
      : this.database.getReviewPolicy(latest.policy_type, latest.policy_version) ?? null
    const reasons: string[] = []
    if (reviewer === null) reasons.push('REVIEWER_IDENTITY_MISSING')
    if (policy === null) reasons.push('REVIEW_POLICY_MISSING')
    if (latest.artifact_hash === null || latest.evidence_hash === null) reasons.push('LEGACY_SIGNATURE_INCOMPLETE')
    const artifactChanged = latest.artifact_hash !== null && latest.artifact_hash !== currentArtifactHash
    const evidenceChanged = latest.evidence_hash !== null && latest.evidence_hash !== currentEvidenceHash
    if (artifactChanged) {
      reasons.push('ARTIFACT_HASH_CHANGED')
      if (latest.decision === 'approved') this.database.createReviewInvalidation({
        id: randomUUID(), review_decision_id: latest.id, artifact_id: artifact.id,
        reason: 'artifact_hash_changed', previous_hash: latest.artifact_hash!, current_hash: currentArtifactHash, created_at: checkedAt,
      })
    }
    if (evidenceChanged) {
      reasons.push('EVIDENCE_HASH_CHANGED')
      if (latest.decision === 'approved') this.database.createReviewInvalidation({
        id: randomUUID(), review_decision_id: latest.id, artifact_id: artifact.id,
        reason: 'evidence_hash_changed', previous_hash: latest.evidence_hash!, current_hash: currentEvidenceHash, created_at: checkedAt,
      })
    }
    const policyPassed = reviewer !== null && policy !== null && this.policyPasses(artifact, reviewer, policy, bundle)
    if (!policyPassed) reasons.push('REVIEW_POLICY_FAILED')
    const invalidations = this.database.listReviewInvalidations(artifact.id, latest.id)
    if (invalidations.length > 0 && !reasons.includes('SIGNATURE_INVALIDATED')) reasons.push('SIGNATURE_INVALIDATED')
    const complete = reviewer !== null && policy !== null && latest.artifact_hash !== null && latest.evidence_hash !== null
    const valid = complete && !artifactChanged && !evidenceChanged && invalidations.length === 0 && policyPassed
    return {
      artifact_id: artifact.id,
      review_decision_id: latest.id,
      status: valid ? 'VALID' : 'INVALID',
      needs_recheck: latest.decision === 'approved' && (!complete || artifactChanged || evidenceChanged || invalidations.length > 0),
      reasons,
      artifact_hash: currentArtifactHash,
      evidence_hash: currentEvidenceHash,
      policy_type: latest.policy_type,
      policy_version: latest.policy_version,
      reviewer,
      policy,
      policy_passed: policyPassed,
      invalidations,
      checked_at: checkedAt,
    }
  }

  private policyPasses(artifact: ArtifactRecord, reviewer: ReviewerProfile, policy: ReviewPolicy, bundle: ArtifactEvidenceBundle): boolean {
    const report = this.audit.inspectArtifact(artifact.id)
    const versions = this.artifacts.history(artifact.id).versions
    const rules = policy.rules
    return rules.artifact_types.includes(artifact.artifact_type)
      && rules.reviewer_roles.includes(reviewer.role)
      && (!rules.require_evidence || bundle.count > 0)
      && (!rules.require_healthy_audit || report.status === 'healthy')
      && (!rules.require_version || versions.length > 0)
      && (!rules.require_available_sources || (bundle.count > 0 && bundle.evidence.every(link => link.source.available)))
  }
}
