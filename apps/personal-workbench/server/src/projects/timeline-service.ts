import type { ProjectContext, ProjectTimelineEvent } from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'

export class ProjectTimelineService {
  constructor(readonly database: WorkbenchDatabase) {}

  list(project: ProjectContext, limit = 100): ProjectTimelineEvent[] {
    const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100
    const safeLimit = Math.max(1, Math.min(200, normalizedLimit))
    const events: ProjectTimelineEvent[] = [{
      timestamp: project.createdAt,
      type: 'project_created',
      title: `项目已创建：${project.name}`,
      source: `project:${project.id}`,
    }]
    for (const snapshot of this.database.listProjectAssetSnapshots(project.id, safeLimit)) {
      events.push({
        timestamp: snapshot.createdAt,
        type: 'scan_completed',
        title: `资产扫描完成：${snapshot.fileCount} 个文件，${snapshot.directoryCount} 个目录`,
        source: `asset_snapshot:${snapshot.id}`,
      })
    }
    for (const task of this.database.listProjectTasks(project.id, safeLimit)) {
      if (task.status !== 'completed') continue
      events.push({
        timestamp: task.completedAt ?? task.createdAt,
        type: 'task_completed',
        title: `任务已完成：${task.title}`,
        source: `workbench_task:${task.id}`,
      })
    }
    for (const reference of this.database.listProjectMemoryReferences(project.id)) {
      events.push({
        timestamp: reference.createdAt,
        type: 'memory_linked',
        title: `Memory 已关联：${reference.memoryProjectName}`,
        source: `memory_reference:${reference.id}`,
      })
    }
    for (const artifact of this.database.listArtifacts({ project_id: project.id, limit: safeLimit })) {
      events.push({
        timestamp: artifact.created_at,
        type: 'artifact_created',
        title: `${artifact.task_id === null ? '项目' : '任务'}登记产物：${artifact.name}`,
        source: `artifact:${artifact.id}`,
        artifact_id: artifact.id,
        name: artifact.name,
        artifact_type: artifact.artifact_type,
      })
      const statusChangedAt = artifact.metadata.status_changed_at
      if (typeof statusChangedAt === 'string' && statusChangedAt.length > 0) {
        events.push({
          timestamp: statusChangedAt,
          type: 'artifact_status_changed',
          title: `产物状态更新：${artifact.name} · ${artifact.status}`,
          source: `artifact_status:${artifact.id}`,
          artifact_id: artifact.id,
          name: artifact.name,
          artifact_type: artifact.artifact_type,
          artifact_status: artifact.status,
        })
      }
    }
    for (const version of this.database.listProjectArtifactVersions(project.id)) {
      if (version.version_number <= 1) continue
      events.push({
        timestamp: version.created_at,
        type: 'artifact_version_created',
        title: `产物新版本：${version.artifact_name} · v${version.version_number}`,
        source: `artifact_version:${version.id}`,
        artifact_id: version.artifact_id,
        name: version.artifact_name,
        artifact_type: version.artifact_type,
        version_number: version.version_number,
      })
    }
    for (const evidence of this.database.listProjectArtifactEvidence(project.id, safeLimit)) {
      events.push({
        timestamp: evidence.created_at,
        type: 'evidence_linked',
        title: `产物证据已关联：${evidence.artifact_name} · ${evidence.relation_type} ${evidence.source_type}:${evidence.source_id}`,
        source: `artifact_evidence:${evidence.id}`,
        artifact_id: evidence.artifact_id,
        name: evidence.artifact_name,
        artifact_type: evidence.artifact_type,
        evidence_id: evidence.id,
        evidence_source_type: evidence.source_type,
        evidence_relation_type: evidence.relation_type,
      })
    }
    for (const audit of this.database.listProjectProvenanceAudits(project.id, safeLimit)) {
      events.push({
        timestamp: audit.created_at,
        type: 'audit_completed',
        title: `产物证据审计完成：${audit.artifact_name} · ${audit.status} · ${audit.issues.length} 项问题`,
        source: `provenance_audit:${audit.id}`,
        artifact_id: audit.artifact_id,
        name: audit.artifact_name,
        artifact_type: audit.artifact_type,
        audit_id: audit.id,
        audit_status: audit.status,
        audit_issue_count: audit.issues.length,
      })
    }
    return events
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || left.source.localeCompare(right.source))
      .slice(0, safeLimit)
  }
}
