import { randomUUID } from 'node:crypto'
import type {
  ArtifactVersionRecord,
  ProjectReviewHistory,
  ReviewChangeReport,
  ReviewDecisionRecord,
  ReviewSnapshotDetail,
  ReviewTimelineEvent,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { ArtifactDiffService } from './artifact-diff-service.ts'
import { ArtifactEvidenceService } from './evidence-service.ts'
import { EvidenceDiffService } from './evidence-diff-service.ts'
import { ReleaseAuditService } from './release-audit-service.ts'
import { ReviewPolicyService } from './review-policy-service.ts'
import { ArtifactService } from './service.ts'

function unique(values: string[]): string[] { return [...new Set(values)] }

export class ReviewChangeService {
  readonly artifactDiff: ArtifactDiffService
  readonly evidenceDiff: EvidenceDiffService

  constructor(
    readonly database: WorkbenchDatabase,
    readonly artifacts: ArtifactService,
    readonly evidence: ArtifactEvidenceService,
    readonly policy: ReviewPolicyService,
    readonly release: ReleaseAuditService,
  ) {
    this.artifactDiff = new ArtifactDiffService(database, artifacts)
    this.evidenceDiff = new EvidenceDiffService(evidence)
  }

  captureReviewSnapshot(review: ReviewDecisionRecord): ReviewSnapshotDetail {
    let artifact: Omit<ReviewSnapshotDetail, 'evidence_snapshot' | 'created_at'>
    try {
      artifact = this.artifactDiff.capture(review.id, review.artifact_id)
    } catch {
      artifact = {
        review_decision_id: review.id,
        artifact_snapshot_path: null,
        artifact_snapshot_sha256: null,
        artifact_snapshot_size: null,
        artifact_snapshot_kind: null,
      }
    }
    return this.database.createReviewSnapshotDetail({
      ...artifact,
      evidence_snapshot: this.evidenceDiff.snapshot(review.artifact_id),
      created_at: review.created_at,
    })
  }

  report(artifactId: string, generatedAt = new Date().toISOString()): ReviewChangeReport {
    const artifact = this.artifacts.get(artifactId)
    const latest = this.database.getLatestArtifactReviewDecision(artifact.id)
    const baseline = latest?.recheck_of_review_id === null || latest?.recheck_of_review_id === undefined
      ? latest
      : this.database.getReviewDecision(latest.recheck_of_review_id) ?? latest
    const detail = baseline === undefined ? undefined : this.database.getReviewSnapshotDetail(baseline.id)
    const signature = this.policy.evaluateSignature(artifact.id, generatedAt)
    const artifactDiff = this.artifactDiff.diff(artifact.id, detail, baseline?.artifact_hash ?? null)
    const evidenceDiff = this.evidenceDiff.diff(artifact.id, detail, baseline?.evidence_hash ?? null)
    const release = this.release.inspectArtifact(artifact.id, generatedAt)
    const baselineInvalidations = baseline === undefined ? [] : this.database.listReviewInvalidations(artifact.id, baseline.id)
    const reasons = unique([
      ...signature.reasons.filter(reason => ['ARTIFACT_HASH_CHANGED', 'EVIDENCE_HASH_CHANGED', 'LEGACY_SIGNATURE_INCOMPLETE', 'SIGNATURE_INVALIDATED'].includes(reason)),
      ...baselineInvalidations.map(item => item.reason.toUpperCase()),
    ])
    const impact: string[] = []
    if (artifactDiff.changed) impact.push(`Artifact 内容变化：新增 ${artifactDiff.added_lines} 行，移除 ${artifactDiff.removed_lines} 行，影响等级 ${artifactDiff.impact_scope}。`)
    if (evidenceDiff.added.length > 0) impact.push(`新增 ${evidenceDiff.added.length} 条 Evidence 关系。`)
    if (evidenceDiff.removed.length > 0) impact.push(`移除 ${evidenceDiff.removed.length} 条 Evidence 关系。`)
    if (evidenceDiff.invalidated.length > 0) impact.push(`${evidenceDiff.invalidated.length} 条 Evidence 来源当前失效。`)
    if (evidenceDiff.restored.length > 0) impact.push(`${evidenceDiff.restored.length} 条 Evidence 来源已经恢复。`)
    if (impact.length === 0) impact.push('当前快照与最近审核签名一致。')
    return {
      artifact_id: artifact.id,
      artifact_name: artifact.name,
      release_status: release.status,
      old_snapshot: {
        review_decision_id: baseline?.id ?? null,
        artifact_hash: baseline?.artifact_hash ?? null,
        evidence_hash: baseline?.evidence_hash ?? null,
        reviewer_id: baseline?.reviewer_id ?? null,
        policy_type: baseline?.policy_type ?? null,
        policy_version: baseline?.policy_version ?? null,
        captured_at: baseline?.created_at ?? null,
      },
      new_snapshot: {
        review_decision_id: null,
        artifact_hash: signature.artifact_hash,
        evidence_hash: signature.evidence_hash,
        reviewer_id: signature.reviewer?.id ?? null,
        policy_type: signature.policy_type,
        policy_version: signature.policy_version,
        captured_at: generatedAt,
      },
      changed_reasons: reasons,
      impact,
      artifact_diff: artifactDiff,
      evidence_diff: evidenceDiff,
      generated_at: generatedAt,
    }
  }

  timeline(artifactId: string): ReviewTimelineEvent[] {
    const artifact = this.artifacts.get(artifactId)
    const reviews = [...this.database.listArtifactReviewDecisions(artifact.id, 500)].reverse()
    const invalidations = [...this.database.listReviewInvalidations(artifact.id)].reverse()
    const events: ReviewTimelineEvent[] = reviews.map((review, index) => ({
      id: `review:${review.id}`,
      artifact_id: artifact.id,
      type: review.recheck_of_review_id !== null ? 'review_rechecked' : index === 0 ? 'initial_review' : 'review_submitted',
      title: review.recheck_of_review_id !== null ? '重新审核完成' : index === 0 ? '首次审核完成' : '审核记录已提交',
      timestamp: review.created_at,
      review_decision_id: review.id,
      decision: review.decision,
      reason: null,
      reviewer: review.reviewer,
      details: {
        reviewer_id: review.reviewer_id,
        policy_type: review.policy_type,
        policy_version: review.policy_version,
        recheck_of_review_id: review.recheck_of_review_id,
        note: review.note,
      },
    }))
    for (const invalidation of invalidations) {
      events.push({
        id: `change:${invalidation.id}`,
        artifact_id: artifact.id,
        type: 'change_detected',
        title: invalidation.reason === 'artifact_hash_changed' ? 'Artifact 内容变化' : 'Evidence 关系变化',
        timestamp: invalidation.created_at,
        review_decision_id: invalidation.review_decision_id,
        decision: null,
        reason: invalidation.reason,
        reviewer: null,
        details: { previous_hash: invalidation.previous_hash, current_hash: invalidation.current_hash },
      })
    }
    return events.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
  }

  projectHistory(projectId: string): ProjectReviewHistory {
    const project = this.database.getProjectContext(projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const artifacts = this.database.listArtifacts({ project_id: project.id, limit: 500 }).flatMap(artifact => {
      const reviews = this.database.listArtifactReviewDecisions(artifact.id, 500)
      if (reviews.length === 0) return []
      return [{ artifact, change_report: this.report(artifact.id), timeline: this.timeline(artifact.id), review_count: reviews.length }]
    })
    const allEvents = artifacts.flatMap(item => item.timeline)
    return {
      project_id: project.id,
      project_name: project.name,
      initial_review_count: allEvents.filter(event => event.type === 'initial_review').length,
      change_event_count: allEvents.filter(event => event.type === 'change_detected').length,
      recheck_count: allEvents.filter(event => event.type === 'review_rechecked').length,
      artifacts,
      generated_at: new Date().toISOString(),
    }
  }

  acceptArtifactRevision(artifactId: string, reviewDecisionId: string): ArtifactVersionRecord | null {
    const artifact = this.artifacts.get(artifactId)
    const observed = this.artifactDiff.observe(artifact.id)
    if (observed.sha256 === artifact.sha256) return null
    if (observed.kind === null || observed.text === null) throw new Error('ARTIFACT_RECHECK_DIFF_UNSUPPORTED')
    const createdAt = new Date().toISOString()
    return this.database.acceptArtifactRevision({
      id: randomUUID(),
      artifact_id: artifact.id,
      sha256: observed.sha256,
      size_bytes: observed.size_bytes,
      created_at: createdAt,
      change_note: `Recheck accepted change from review ${reviewDecisionId}`,
      metadata: {
        ...artifact.metadata,
        previous_hash: artifact.sha256,
        current_hash: observed.sha256,
        previous_status: artifact.status,
        review_recheck_accepted_at: createdAt,
      },
    })
  }
}
