import { randomUUID } from 'node:crypto'
import {
  REVIEW_DECISIONS,
  type ArtifactReviewHistory,
  type ProjectReviewQueue,
  type ProjectReviewSummary,
  type ReviewDecision,
  type ReviewDecisionRecord,
  type ReviewEvidenceStatus,
  type ReviewQueueSeverity,
  type ReviewRecheckResult,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { ArtifactEvidenceService } from './evidence-service.ts'
import { EvidenceAuditService } from './evidence-audit-service.ts'
import { ReleaseAuditService } from './release-audit-service.ts'
import { ReviewPolicyService } from './review-policy-service.ts'
import { ReviewChangeService } from './review-change-service.ts'
import { ArtifactService } from './service.ts'

export interface ReviewSubmitInput {
  decision: ReviewDecision
  reviewer?: string
  reviewer_id?: string
  reviewer_role?: string
  policy_type?: string
  note?: string
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`INVALID_REVIEW_${field.toUpperCase()}`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum || normalized.includes('\0')) {
    throw new Error(`INVALID_REVIEW_${field.toUpperCase()}`)
  }
  return normalized
}

function optionalNote(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > 2000 || value.includes('\0')) throw new Error('INVALID_REVIEW_NOTE')
  return value.trim()
}

function reviewDecision(value: unknown): ReviewDecision {
  if (typeof value !== 'string' || !REVIEW_DECISIONS.includes(value as ReviewDecision)) {
    throw new Error('INVALID_REVIEW_DECISION')
  }
  return value as ReviewDecision
}

export class ReviewQueueService {
  constructor(
    readonly database: WorkbenchDatabase,
    readonly artifacts: ArtifactService,
    readonly evidence: ArtifactEvidenceService,
    readonly audit: EvidenceAuditService,
    readonly release: ReleaseAuditService,
    readonly policy: ReviewPolicyService = new ReviewPolicyService(database, artifacts, evidence, audit),
    readonly changes: ReviewChangeService = new ReviewChangeService(database, artifacts, evidence, policy, release),
  ) {}

  submitReview(artifactId: string, input: ReviewSubmitInput): ReviewDecisionRecord {
    return this.createReview(artifactId, input, null)
  }

  recheckReview(artifactId: string, input: ReviewSubmitInput): ReviewRecheckResult {
    const artifact = this.artifacts.get(artifactId)
    const latest = this.database.getLatestArtifactReviewDecision(artifact.id)
    if (latest === undefined) throw new Error('RECHECK_REVIEW_NOT_FOUND')
    const signature = this.policy.evaluateSignature(artifact.id)
    if (!signature.needs_recheck) throw new Error('RECHECK_NOT_REQUIRED')
    const changeReport = this.changes.report(artifact.id)
    const decision = reviewDecision(input.decision)
    const acceptedVersion = decision === 'approved' ? this.changes.acceptArtifactRevision(artifact.id, latest.id) : null
    const review = this.createReview(artifact.id, input, latest.id)
    return {
      review,
      previous_review_id: latest.id,
      accepted_version: acceptedVersion,
      change_report: changeReport,
      release: this.release.inspectArtifact(artifact.id),
      timeline: this.changes.timeline(artifact.id),
    }
  }

  private createReview(artifactId: string, input: ReviewSubmitInput, recheckOfReviewId: string | null): ReviewDecisionRecord {
    const artifact = this.artifacts.get(artifactId)
    if (input === null || typeof input !== 'object') throw new Error('INVALID_REVIEW_INPUT')
    const reviewer = this.policy.resolveReviewer({ reviewer_id: input.reviewer_id, reviewer: input.reviewer, role: input.reviewer_role })
    const selectedPolicy = this.policy.resolvePolicy(artifact, input.policy_type)
    const snapshot = this.policy.signatureSnapshot(artifact.id, reviewer, selectedPolicy)
    const review = this.database.createReviewDecision({
      id: randomUUID(),
      artifact_id: artifact.id,
      decision: reviewDecision(input.decision),
      reviewer: requiredText(reviewer.name, 'reviewer', 128),
      reviewer_id: reviewer.id,
      artifact_hash: snapshot.artifact_hash,
      evidence_hash: snapshot.evidence_hash,
      policy_type: selectedPolicy.policy_type,
      policy_version: selectedPolicy.version,
      recheck_of_review_id: recheckOfReviewId,
      note: optionalNote(input.note),
      created_at: new Date().toISOString(),
    })
    this.changes.captureReviewSnapshot(review)
    return review
  }

  getReviewHistory(artifactId: string): ArtifactReviewHistory {
    const artifact = this.artifacts.get(artifactId)
    const history = this.database.listArtifactReviewDecisions(artifact.id)
    const currentSignature = this.policy.evaluateSignature(artifact.id)
    return {
      artifact,
      current_decision: history[0]?.decision ?? 'pending',
      history,
      current_signature: currentSignature,
      invalidations: this.database.listReviewInvalidations(artifact.id),
      timeline: this.changes.timeline(artifact.id),
      count: history.length,
    }
  }

  getPendingReviews(projectId: string): ProjectReviewQueue {
    const project = this.database.getProjectContext(projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const generatedAt = new Date().toISOString()
    const reviews = this.database.listArtifacts({ project_id: project.id, limit: 500 }).flatMap(artifact => {
      const evidence = this.evidence.forArtifact(artifact.id)
      const audit = this.audit.inspectArtifact(artifact.id, generatedAt)
      const release = this.release.inspectArtifact(artifact.id, generatedAt, audit)
      if (audit.status === 'healthy' && release.status === 'READY') return []
      const latest = this.database.getLatestArtifactReviewDecision(artifact.id)
      const signature = this.policy.evaluateSignature(artifact.id, generatedAt)
      let severity: ReviewQueueSeverity = 'needs_review'
      if (release.status === 'NEEDS_RECHECK') severity = 'needs_recheck'
      else if (audit.status === 'broken') severity = 'broken'
      else if (audit.issues.some(issue => issue.code === 'EVIDENCE_MISSING')) severity = 'missing'
      else if (audit.status === 'warning') severity = 'warning'
      const evidenceStatus: ReviewEvidenceStatus = evidence.count === 0
        ? 'missing'
        : evidence.evidence.some(link => !link.source.available) ? 'broken' : 'available'
      const issue = release.status === 'NEEDS_RECHECK'
        ? 'Artifact 或 Evidence 已在批准后变化，需要重新审核。'
        : signature.reasons.includes('REVIEW_POLICY_FAILED') && latest?.decision === 'approved'
          ? '当前 Reviewer、Artifact 类型或 Evidence 状态未通过 Review Policy。'
        : audit.issues.length > 0
        ? audit.issues.map(item => item.message).join('；')
        : 'Artifact 尚未获得人工批准。'
      return [{
        artifact_id: artifact.id,
        artifact_name: artifact.name,
        artifact_type: artifact.artifact_type,
        artifact_status: artifact.status,
        issue,
        issues: audit.issues,
        severity,
        evidence_status: evidenceStatus,
        audit_status: audit.status,
        release_status: release.status,
        current_decision: latest?.decision ?? 'pending',
        signature_status: signature.status,
        reviewer: signature.reviewer,
        policy_type: signature.policy_type,
        policy_version: signature.policy_version,
        invalidation_count: signature.invalidations.length,
        updated_at: latest?.created_at ?? artifact.created_at,
      }]
    }).sort((left, right) => {
      const order: Record<ReviewQueueSeverity, number> = { broken: 0, needs_recheck: 1, missing: 2, warning: 3, needs_review: 4 }
      return order[left.severity] - order[right.severity]
        || right.updated_at.localeCompare(left.updated_at)
        || left.artifact_name.localeCompare(right.artifact_name)
    })
    return {
      project_id: project.id,
      project_name: project.name,
      count: reviews.length,
      reviews,
      generated_at: generatedAt,
    }
  }

  getReviewSummary(projectId: string): ProjectReviewSummary {
    const project = this.database.getProjectContext(projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const artifacts = this.database.listArtifacts({ project_id: project.id, limit: 500 })
    const latest = new Map(this.database.listProjectLatestReviewDecisions(project.id).map(record => [record.artifact_id, record.decision]))
    const decisions = artifacts.map(artifact => latest.get(artifact.id) ?? 'pending')
    const releases = artifacts.map(artifact => this.release.inspectArtifact(artifact.id))
    return {
      project_id: project.id,
      project_name: project.name,
      artifact_count: artifacts.length,
      pending: decisions.filter(decision => decision === 'pending').length,
      approved: decisions.filter(decision => decision === 'approved').length,
      needs_revision: decisions.filter(decision => decision === 'needs_revision').length,
      rejected: decisions.filter(decision => decision === 'rejected').length,
      needs_recheck: releases.filter(release => release.status === 'NEEDS_RECHECK').length,
      queue_count: this.getPendingReviews(project.id).count,
      reviewers: this.policy.listReviewers(),
      active_policies: this.policy.listPolicies(),
      generated_at: new Date().toISOString(),
    }
  }
}
