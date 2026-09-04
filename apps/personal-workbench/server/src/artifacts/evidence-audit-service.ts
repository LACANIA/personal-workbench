import { randomUUID } from 'node:crypto'
import type {
  ArtifactEvidenceAuditReport,
  EvidenceAuditIssue,
  EvidenceAuditStatus,
  ProjectEvidenceAuditReport,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { ArtifactEvidenceService } from './evidence-service.ts'
import { ArtifactService } from './service.ts'

function reportStatus(issues: EvidenceAuditIssue[]): EvidenceAuditStatus {
  if (issues.some(issue => issue.severity === 'broken')) return 'broken'
  if (issues.length > 0) return 'warning'
  return 'healthy'
}

function addIssue(issues: EvidenceAuditIssue[], issue: EvidenceAuditIssue): void {
  if (!issues.some(existing => existing.code === issue.code && existing.evidence_id === issue.evidence_id && existing.source_id === issue.source_id)) {
    issues.push(issue)
  }
}

export class EvidenceAuditService {
  constructor(
    readonly database: WorkbenchDatabase,
    readonly artifacts: ArtifactService,
    readonly evidence: ArtifactEvidenceService,
  ) {}

  inspectArtifact(artifactId: string, checkedAt = new Date().toISOString()): ArtifactEvidenceAuditReport {
    const artifact = this.artifacts.get(artifactId)
    const bundle = this.evidence.forArtifact(artifact.id)
    const issues: EvidenceAuditIssue[] = []
    if (bundle.evidence.length === 0) {
      addIssue(issues, {
        code: 'EVIDENCE_MISSING',
        severity: 'warning',
        message: 'Artifact 当前没有 Evidence 关系。',
      })
    }
    for (const link of bundle.evidence) {
      if (link.source.available) continue
      const error = typeof link.source.metadata.error === 'string' ? link.source.metadata.error : 'EVIDENCE_SOURCE_UNAVAILABLE'
      addIssue(issues, {
        code: error === 'EVIDENCE_PROJECT_DENIED' ? 'EVIDENCE_CROSS_PROJECT' : 'EVIDENCE_SOURCE_UNAVAILABLE',
        severity: 'broken',
        message: error === 'EVIDENCE_PROJECT_DENIED' ? 'Evidence 指向其他 Workbench 项目。' : 'Evidence 来源当前不存在或无法读取。',
        evidence_id: link.id,
        source_type: link.source_type,
        source_id: link.source_id,
      })
    }
    if (artifact.status === 'missing') {
      addIssue(issues, { code: 'ARTIFACT_MISSING', severity: 'broken', message: 'Artifact 文件当前不存在。' })
    } else if (artifact.status === 'outdated') {
      addIssue(issues, { code: 'ARTIFACT_OUTDATED', severity: 'warning', message: 'Artifact 当前文件哈希与登记哈希不同。' })
    }
    this.inspectVersionRelations(artifact.id, artifact.project_id, issues)
    return {
      audit_id: null,
      artifact_id: artifact.id,
      project_id: artifact.project_id,
      status: reportStatus(issues),
      issues,
      evidence_count: bundle.count,
      checked_at: checkedAt,
    }
  }

  auditArtifact(artifactId: string): ArtifactEvidenceAuditReport {
    const report = this.inspectArtifact(artifactId)
    const record = this.database.createProvenanceAuditRecord({
      id: randomUUID(),
      artifact_id: report.artifact_id,
      status: report.status,
      issues: report.issues,
      created_at: report.checked_at,
    })
    return { ...report, audit_id: record.id }
  }

  auditProject(projectId: string): ProjectEvidenceAuditReport {
    const project = this.database.getProjectContext(projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const checkedAt = new Date().toISOString()
    const artifacts = this.database.listArtifacts({ project_id: project.id, limit: 500 })
      .map(artifact => this.inspectArtifact(artifact.id, checkedAt))
    const status: EvidenceAuditStatus = artifacts.some(report => report.status === 'broken')
      ? 'broken'
      : artifacts.some(report => report.status === 'warning') ? 'warning' : 'healthy'
    return {
      project_id: project.id,
      project_name: project.name,
      status,
      artifact_count: artifacts.length,
      issue_count: artifacts.reduce((total, report) => total + report.issues.length, 0),
      artifacts,
      checked_at: checkedAt,
    }
  }

  private inspectVersionRelations(artifactId: string, projectId: string, issues: EvidenceAuditIssue[]): void {
    const history = this.artifacts.history(artifactId)
    if (history.versions.length === 0) {
      addIssue(issues, { code: 'ARTIFACT_VERSION_MISSING', severity: 'broken', message: 'Artifact 没有版本快照。' })
      return
    }
    const records = new Map(history.artifacts.map(artifact => [artifact.id, artifact]))
    for (const link of history.links) {
      const oldArtifact = records.get(link.old_artifact_id)
      const newArtifact = records.get(link.new_artifact_id)
      if (oldArtifact === undefined || newArtifact === undefined) {
        addIssue(issues, { code: 'ARTIFACT_VERSION_SOURCE_MISSING', severity: 'broken', message: 'Artifact 版本关系存在缺失端点。' })
        continue
      }
      if (oldArtifact.project_id !== projectId || newArtifact.project_id !== projectId) {
        addIssue(issues, { code: 'ARTIFACT_VERSION_CROSS_PROJECT', severity: 'broken', message: 'Artifact 版本关系跨越了 Project Context。' })
      }
    }
  }
}
