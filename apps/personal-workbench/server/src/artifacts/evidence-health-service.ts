import type {
  EvidenceHealthIssueSeverity,
  ProjectEvidenceHealth,
  ProjectEvidenceHealthIssue,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { EvidenceAuditService } from './evidence-audit-service.ts'
import { ReleaseAuditService } from './release-audit-service.ts'

const SEVERITY_ORDER: Record<EvidenceHealthIssueSeverity, number> = {
  broken: 0,
  missing: 1,
  warning: 2,
}

export class EvidenceHealthService {
  constructor(
    readonly database: WorkbenchDatabase,
    readonly audit: EvidenceAuditService,
    readonly releaseAudit: ReleaseAuditService,
  ) {}

  getProjectEvidenceHealth(projectId: string): ProjectEvidenceHealth {
    const project = this.database.getProjectContext(projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const checkedAt = new Date().toISOString()
    const artifacts = this.database.listArtifacts({ project_id: project.id, limit: 500 })
    const reports = artifacts.map(artifact => ({
      artifact,
      audit: this.audit.inspectArtifact(artifact.id, checkedAt),
    }))
    const releaseReadiness = reports.map(({ artifact, audit }) => this.releaseAudit.inspectArtifact(artifact.id, checkedAt, audit))
    const issues: ProjectEvidenceHealthIssue[] = reports.flatMap(({ artifact, audit }) => audit.issues.map(issue => {
      const severity: EvidenceHealthIssueSeverity = issue.code === 'EVIDENCE_MISSING' ? 'missing' : issue.severity
      return {
        artifact_id: artifact.id,
        artifact_name: artifact.name,
        severity,
        code: issue.code,
        issue: issue.message,
        created_at: checkedAt,
      }
    }))
      .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
        || left.artifact_name.localeCompare(right.artifact_name)
        || left.code.localeCompare(right.code))
    const coveredCount = reports.filter(row => row.audit.evidence_count > 0).length
    const healthSummary = {
      healthy: reports.filter(row => row.audit.status === 'healthy').length,
      warning: reports.filter(row => row.audit.status === 'warning').length,
      broken: reports.filter(row => row.audit.status === 'broken').length,
    }
    return {
      project_id: project.id,
      project_name: project.name,
      artifact_count: artifacts.length,
      covered_count: coveredCount,
      coverage: artifacts.length === 0 ? 0 : coveredCount / artifacts.length,
      health_summary: healthSummary,
      issue_count: issues.length,
      issues,
      recent_audits: this.database.listProjectProvenanceAudits(project.id, 10),
      release_summary: {
        ready: releaseReadiness.filter(report => report.status === 'READY').length,
        needs_review: releaseReadiness.filter(report => report.status === 'NEEDS_REVIEW').length,
        needs_recheck: releaseReadiness.filter(report => report.status === 'NEEDS_RECHECK').length,
        rejected: releaseReadiness.filter(report => report.status === 'REJECTED').length,
      },
      release_readiness: releaseReadiness,
      checked_at: checkedAt,
    }
  }
}
