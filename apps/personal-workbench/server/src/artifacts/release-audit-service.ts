import type {
  ArtifactEvidenceAuditReport,
  ArtifactReleaseAuditCheck,
  ArtifactReleaseAuditReport,
} from '../../../shared/contracts/index.ts'
import { ArtifactEvidenceService } from './evidence-service.ts'
import { EvidenceAuditService } from './evidence-audit-service.ts'
import { ArtifactService } from './service.ts'
import { ReviewPolicyService } from './review-policy-service.ts'

export class ReleaseAuditService {
  constructor(
    readonly artifacts: ArtifactService,
    readonly evidence: ArtifactEvidenceService,
    readonly audit: EvidenceAuditService,
    readonly policy: ReviewPolicyService = new ReviewPolicyService(artifacts.database, artifacts, evidence, audit),
  ) {}

  inspectArtifact(
    artifactId: string,
    checkedAt = new Date().toISOString(),
    auditReport?: ArtifactEvidenceAuditReport,
  ): ArtifactReleaseAuditReport {
    const artifact = this.artifacts.get(artifactId)
    const evidence = this.evidence.forArtifact(artifact.id)
    const report = auditReport ?? this.audit.inspectArtifact(artifact.id, checkedAt)
    const history = this.artifacts.history(artifact.id)
    const reviewDecision = this.artifacts.database.getLatestArtifactReviewDecision(artifact.id)?.decision ?? 'pending'
    const signature = this.policy.evaluateSignature(artifact.id, checkedAt)
    const checks: ArtifactReleaseAuditCheck[] = [
      {
        id: 'evidence_present',
        passed: evidence.count > 0,
        message: evidence.count > 0 ? `已登记 ${evidence.count} 条 Evidence。` : 'Artifact 尚未登记 Evidence。',
      },
      {
        id: 'audit_healthy',
        passed: report.status === 'healthy',
        message: report.status === 'healthy' ? 'Evidence Audit 当前为 healthy。' : `Evidence Audit 当前为 ${report.status}。`,
      },
      {
        id: 'version_present',
        passed: history.versions.length > 0,
        message: history.versions.length > 0 ? `已登记 ${history.versions.length} 个版本快照。` : 'Artifact 尚无版本快照。',
      },
      {
        id: 'source_available',
        passed: evidence.count > 0 && evidence.evidence.every(link => link.source.available),
        message: evidence.count > 0 && evidence.evidence.every(link => link.source.available)
          ? '所有 Evidence 来源当前可以解析。'
          : '至少一个 Evidence 来源缺失，或尚未登记来源。',
      },
      {
        id: 'review_approved',
        passed: reviewDecision === 'approved',
        message: reviewDecision === 'approved'
          ? 'Artifact 已获得人工批准。'
          : `Artifact 当前人工审核状态为 ${reviewDecision}。`,
      },
      {
        id: 'policy_pass',
        passed: signature.policy_passed,
        message: signature.policy_passed
          ? `${signature.policy_type ?? 'unknown'} Policy ${signature.policy_version ?? ''} 检查通过。`
          : 'Reviewer、Artifact 或 Evidence 未通过当前 Review Policy。',
      },
      {
        id: 'signature_valid',
        passed: signature.status === 'VALID',
        message: signature.status === 'VALID'
          ? 'Review Signature 当前有效。'
          : `Review Signature 当前无效：${signature.reasons.join(', ') || 'UNKNOWN'}。`,
      },
    ]
    return {
      artifact_id: artifact.id,
      project_id: artifact.project_id,
      status: reviewDecision === 'rejected'
        ? 'REJECTED'
        : signature.needs_recheck
          ? 'NEEDS_RECHECK'
          : checks.every(check => check.passed) ? 'READY' : 'NEEDS_REVIEW',
      review_decision: reviewDecision,
      signature_status: signature.status,
      policy_type: signature.policy_type,
      policy_version: signature.policy_version,
      invalidations: signature.invalidations,
      checks,
      checked_at: checkedAt,
    }
  }
}
