import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ARTIFACT_EVIDENCE_RELATION_TYPES,
  ARTIFACT_EVIDENCE_SOURCE_TYPES,
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  type ArtifactEvidenceBundle,
  type ArtifactEvidenceAuditReport,
  type ArtifactEvidenceRelationType,
  type ArtifactEvidenceSourceType,
  type ArtifactHistory,
  type ArtifactPreview,
  type ArtifactRecord,
  type ArtifactProvenanceGraph,
  type ArtifactReviewHistory,
  type ArtifactStatus,
  type ArtifactType,
  type DatabaseRole,
  type MemoryEntityType,
  type ProjectContextView,
  type ProjectEvidenceHealth,
  type ProjectReviewSummary,
  type ProjectRecommendedAction,
  type ProjectSnapshotHistoryItem,
  type ProjectTimelineEvent,
  type TaskCreateInput,
  type ReviewDecision,
  type ReviewPolicyType,
} from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import type { AppSnapshot } from '../app/types.ts'
import { Badge, EmptyState, formatBytes, Metric, Panel } from '../components/common.tsx'
import { EvidenceIssueCenter } from '../components/EvidenceIssueCenter.tsx'
import { ProvenanceGraph } from '../components/ProvenanceGraph.tsx'

const TYPE_LABELS: Record<ProjectContextView['projectType'], string> = {
  node: 'Node.js 项目',
  python: 'Python 项目',
  mixed: '混合工程',
  research: '科研资料',
  software: '软件工程',
  documentation: '文档项目',
  general: '通用项目',
}

const TIMELINE_LABELS: Record<ProjectTimelineEvent['type'], string> = {
  project_created: '项目',
  scan_completed: '扫描',
  task_completed: '任务',
  memory_linked: 'Memory',
  artifact_created: '产物',
  artifact_version_created: '版本',
  artifact_status_changed: '状态',
  evidence_linked: 'Evidence',
  audit_completed: '审计',
}

const ARTIFACT_STATUS_LABELS: Record<ArtifactStatus, string> = {
  active: '正常',
  missing: '文件缺失',
  outdated: '内容已变化',
  archived: '已归档',
}

function replaceProject(rows: ProjectContextView[], project: ProjectContextView): ProjectContextView[] {
  return [project, ...rows.filter(item => item.id !== project.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function signedNumber(value: number): string {
  if (value > 0) return `+${value}`
  return String(value)
}

function signedBytes(value: number): string {
  if (value === 0) return '无变化'
  return `${value > 0 ? '+' : '−'}${formatBytes(Math.abs(value))}`
}

function changeTitle(project: ProjectContextView): string {
  const change = project.changeSummary
  if (change === null) return '等待第二次扫描'
  if (change.file_count_change === 0 && change.size_change === 0 && change.new_extensions.length === 0 && change.removed_extensions.length === 0) return '未检测到聚合变化'
  if (change.file_count_change > 0) return `文件增加 ${change.file_count_change}`
  if (change.file_count_change < 0) return `文件减少 ${Math.abs(change.file_count_change)}`
  return `容量变化 ${signedBytes(change.size_change)}`
}

export function ProjectsPage({
  snapshot,
  databaseRole,
  onOpenTask,
  onRefresh,
}: {
  snapshot: AppSnapshot
  databaseRole: DatabaseRole
  onOpenTask(id: string): void
  onRefresh(): Promise<void>
}): JSX.Element {
  const [projects, setProjects] = useState<ProjectContextView[]>(snapshot.projectContexts)
  const [selectedId, setSelectedId] = useState<string | null>(snapshot.projectContexts[0]?.id ?? null)
  const [history, setHistory] = useState<ProjectSnapshotHistoryItem[]>([])
  const [timeline, setTimeline] = useState<ProjectTimelineEvent[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([])
  const [evidenceHealth, setEvidenceHealth] = useState<ProjectEvidenceHealth | null>(null)
  const [reviewSummary, setReviewSummary] = useState<ProjectReviewSummary | null>(null)
  const [projectDetailTab, setProjectDetailTab] = useState<'overview' | 'evidence'>('overview')
  const [artifactFilter, setArtifactFilter] = useState<ArtifactType | ''>('')
  const [artifactStatusFilter, setArtifactStatusFilter] = useState<ArtifactStatus | ''>('')
  const [artifactPath, setArtifactPath] = useState('')
  const [artifactRegisterType, setArtifactRegisterType] = useState<ArtifactType>('report')
  const [artifactSupersedesId, setArtifactSupersedesId] = useState('')
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreview | null>(null)
  const [artifactHistory, setArtifactHistory] = useState<ArtifactHistory | null>(null)
  const [artifactEvidence, setArtifactEvidence] = useState<ArtifactEvidenceBundle | null>(null)
  const [artifactProvenance, setArtifactProvenance] = useState<ArtifactProvenanceGraph | null>(null)
  const [artifactAudit, setArtifactAudit] = useState<ArtifactEvidenceAuditReport | null>(null)
  const [artifactReview, setArtifactReview] = useState<ArtifactReviewHistory | null>(null)
  const [reviewerId, setReviewerId] = useState('')
  const [reviewPolicyType, setReviewPolicyType] = useState<ReviewPolicyType>('research')
  const [reviewNote, setReviewNote] = useState('')
  const [evidenceSourceType, setEvidenceSourceType] = useState<ArtifactEvidenceSourceType>('task')
  const [evidenceSourceId, setEvidenceSourceId] = useState('')
  const [evidenceRelationType, setEvidenceRelationType] = useState<ArtifactEvidenceRelationType>('references')
  const [evidenceMemoryType, setEvidenceMemoryType] = useState<MemoryEntityType>('decision')
  const [rootPath, setRootPath] = useState(snapshot.localConfig?.project_path ?? snapshot.workspaces.allowedRoots[0] ?? '')
  const [name, setName] = useState('Personal Agent')
  const [description, setDescription] = useState('本机 Personal Agent 扩展、Memory 与 Workbench 工程。')
  const [memoryProjectId, setMemoryProjectId] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanningId, setScanningId] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [artifactBusy, setArtifactBusy] = useState<string | null>(null)
  const [intelligenceLoading, setIntelligenceLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    setProjects(snapshot.projectContexts)
    setSelectedId(current => current ?? snapshot.projectContexts[0]?.id ?? null)
  }, [snapshot.projectContexts])

  const selected = useMemo(() => projects.find(project => project.id === selectedId) ?? projects[0] ?? null, [projects, selectedId])
  const memoryProjects = useMemo(() => snapshot.projects.map(row => ({ id: String(row.id), name: String(row.name) })), [snapshot.projects])
  const availableMemoryProjects = useMemo(() => memoryProjects.filter(row => selected?.memoryReferences.some(reference => reference.memoryRole === databaseRole && reference.memoryEntityId === row.id) !== true), [memoryProjects, selected, databaseRole])

  useEffect(() => {
    setMemoryProjectId(current => availableMemoryProjects.some(row => row.id === current) ? current : (availableMemoryProjects[0]?.id ?? ''))
  }, [availableMemoryProjects])

  const refreshIntelligence = useCallback(async (id: string) => {
    setIntelligenceLoading(true)
    try {
      const [historyRows, timelineRows, artifactRows, health, reviews] = await Promise.all([
        api.projectHistory(id),
        api.projectTimeline(id),
        api.projectArtifacts(id, artifactFilter || undefined, artifactStatusFilter || undefined),
        api.projectEvidenceHealth(id),
        api.projectReviewSummary(id),
      ])
      setHistory(historyRows)
      setTimeline(timelineRows)
      setArtifacts(artifactRows)
      setEvidenceHealth(health)
      setReviewSummary(reviews)
      const reviewerRows = reviews.reviewers ?? []
      setReviewerId(current => reviewerRows.some(item => item.id === current) ? current : (reviewerRows[0]?.id ?? ''))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIntelligenceLoading(false)
    }
  }, [artifactFilter, artifactStatusFilter])

  useEffect(() => {
    if (selectedId === null) { setHistory([]); setTimeline([]); setArtifacts([]); setEvidenceHealth(null); setReviewSummary(null); return }
    void refreshIntelligence(selectedId)
  }, [selectedId, refreshIntelligence])

  const register = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const created = await api.registerProject({ rootPath, ...(name.trim() ? { name } : {}), ...(description.trim() ? { description } : {}) })
      setProjects(rows => replaceProject(rows, created)); setSelectedId(created.id)
      const scanned = await api.scanProject(created.id)
      setProjects(rows => replaceProject(rows, scanned)); setSelectedId(scanned.id)
      await refreshIntelligence(scanned.id)
      await onRefresh()
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }

  const scan = async (id: string) => {
    setScanningId(id); setError(''); setNotice('')
    try {
      const result = await api.scanProject(id)
      setProjects(rows => replaceProject(rows, result)); setSelectedId(result.id)
      await refreshIntelligence(result.id)
      await onRefresh()
      setNotice('项目扫描与变化分析已经更新。')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setScanningId(null) }
  }

  const runAction = async (action: ProjectRecommendedAction) => {
    if (selected === null) return
    setActionBusy(action.action_type); setError(''); setNotice('')
    try {
      if (action.action_type === 'rescan_project') {
        await scan(selected.id)
        return
      }
      const task = await api.createTask(action.payload as unknown as TaskCreateInput)
      const refreshed = await api.projectContext(selected.id)
      setProjects(rows => replaceProject(rows, refreshed))
      await onRefresh()
      setNotice(`任务请求已经创建：${task.title}`)
      onOpenTask(task.id)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setActionBusy(null) }
  }

  const linkMemory = async () => {
    if (selected === null || memoryProjectId.length === 0) return
    setActionBusy('memory-link'); setError(''); setNotice('')
    try {
      const result = await api.linkProjectMemory(selected.id, memoryProjectId, databaseRole)
      setProjects(rows => replaceProject(rows, result))
      await refreshIntelligence(result.id)
      setNotice('Memory 项目引用已经添加。')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setActionBusy(null) }
  }

  const unlinkMemory = async (memoryProjectIdToRemove: string, role: DatabaseRole) => {
    if (selected === null) return
    setActionBusy(`memory-unlink:${role}:${memoryProjectIdToRemove}`); setError(''); setNotice('')
    try {
      const result = await api.unlinkProjectMemory(selected.id, memoryProjectIdToRemove, role)
      setProjects(rows => replaceProject(rows, result))
      await refreshIntelligence(result.id)
      setNotice('Memory 项目引用已经移除。')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setActionBusy(null) }
  }

  const registerArtifact = async () => {
    if (selected === null || artifactPath.trim().length === 0) return
    setArtifactBusy('register'); setError(''); setNotice('')
    try {
      const artifact = await api.registerArtifact({
        project_id: selected.id,
        file_path: artifactPath.trim(),
        artifact_type: artifactRegisterType,
        metadata: { origin: 'project-artifact-form' },
        ...(artifactSupersedesId.length === 0 ? {} : { supersedes_artifact_id: artifactSupersedesId, change_note: '由项目页面登记的新版本' }),
      })
      setArtifactPath('')
      setArtifactSupersedesId('')
      await refreshIntelligence(selected.id)
      setNotice(`Artifact 索引已经登记：${artifact.name}`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const previewArtifact = async (artifact: ArtifactRecord) => {
    setArtifactBusy(`preview:${artifact.id}`); setError(''); setNotice('')
    try { setArtifactPreview(await api.previewArtifact(artifact.id)); setArtifactHistory(null); setArtifactEvidence(null); setArtifactProvenance(null); setArtifactAudit(null); setArtifactReview(null) }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const showArtifactHistory = async (artifact: ArtifactRecord) => {
    setArtifactBusy(`history:${artifact.id}`); setError(''); setNotice('')
    try { setArtifactHistory(await api.artifactHistory(artifact.id)); setArtifactPreview(null); setArtifactEvidence(null); setArtifactProvenance(null); setArtifactAudit(null); setArtifactReview(null) }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const showArtifactEvidence = async (artifactId: string) => {
    setArtifactBusy(`evidence:${artifactId}`); setError(''); setNotice('')
    try {
      setArtifactEvidence(await api.artifactEvidence(artifactId))
      setArtifactPreview(null)
      setArtifactHistory(null)
      setArtifactProvenance(null)
      setArtifactAudit(null)
      setArtifactReview(null)
      setEvidenceSourceId('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const showArtifactProvenance = async (artifactId: string) => {
    setArtifactBusy(`provenance:${artifactId}`); setError(''); setNotice('')
    try {
      setArtifactProvenance(await api.artifactProvenance(artifactId))
      setArtifactPreview(null)
      setArtifactHistory(null)
      setArtifactEvidence(null)
      setArtifactAudit(null)
      setArtifactReview(null)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const auditArtifact = async (artifactId: string) => {
    setArtifactBusy(`audit:${artifactId}`); setError(''); setNotice('')
    try {
      const report = await api.auditArtifact(artifactId)
      setArtifactAudit(report)
      setArtifactPreview(null)
      setArtifactHistory(null)
      setArtifactEvidence(null)
      setArtifactProvenance(null)
      setArtifactReview(null)
      if (selected !== null) await refreshIntelligence(selected.id)
      setNotice(`Evidence 审计完成：${report.status}，${report.issues.length} 项问题。`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const exportArtifactProvenance = async (artifactId: string) => {
    setArtifactBusy(`export:${artifactId}`); setError(''); setNotice('')
    try {
      const manifest = await api.artifactProvenanceExport(artifactId)
      const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'artifact-provenance.json'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setNotice('Provenance Manifest 已导出。')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const showArtifactReview = async (artifactId: string) => {
    setArtifactBusy(`review:${artifactId}`); setError(''); setNotice('')
    try {
      setArtifactReview(await api.artifactReviewHistory(artifactId))
      setArtifactPreview(null)
      setArtifactHistory(null)
      setArtifactEvidence(null)
      setArtifactProvenance(null)
      setArtifactAudit(null)
      setReviewNote('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const submitArtifactReview = async (decision: ReviewDecision) => {
    if (artifactReview === null) return
    setArtifactBusy(`review-submit:${artifactReview.artifact.id}`); setError(''); setNotice('')
    try {
      await api.submitArtifactReview(artifactReview.artifact.id, { decision, reviewer_id: reviewerId, policy_type: reviewPolicyType, note: reviewNote })
      setArtifactReview(await api.artifactReviewHistory(artifactReview.artifact.id))
      setReviewNote('')
      if (selected !== null) await refreshIntelligence(selected.id)
      setNotice(`人工审核记录已经追加：${decision}。`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const createArtifactEvidence = async () => {
    if (artifactEvidence === null || evidenceSourceId.trim().length === 0) return
    setArtifactBusy(`evidence-create:${artifactEvidence.artifact.id}`); setError(''); setNotice('')
    try {
      await api.createArtifactEvidence(artifactEvidence.artifact.id, {
        source_type: evidenceSourceType,
        source_id: evidenceSourceId.trim(),
        relation_type: evidenceRelationType,
        ...(['memory', 'document_chunk', 'source'].includes(evidenceSourceType) ? { database_role: databaseRole } : {}),
        ...(evidenceSourceType === 'memory' ? { memory_type: evidenceMemoryType } : {}),
      })
      setArtifactEvidence(await api.artifactEvidence(artifactEvidence.artifact.id))
      setEvidenceSourceId('')
      if (selected !== null) await refreshIntelligence(selected.id)
      setNotice('Evidence 关系已经建立。')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const removeArtifactEvidence = async (evidenceId: string) => {
    if (artifactEvidence === null) return
    setArtifactBusy(`evidence-delete:${evidenceId}`); setError(''); setNotice('')
    try {
      await api.deleteArtifactEvidence(evidenceId)
      setArtifactEvidence(await api.artifactEvidence(artifactEvidence.artifact.id))
      if (selected !== null) await refreshIntelligence(selected.id)
      setNotice('Evidence 关系已经移除，关联对象保持原状。')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const checkArtifact = async (artifact: ArtifactRecord) => {
    if (selected === null) return
    setArtifactBusy(`check:${artifact.id}`); setError(''); setNotice('')
    try {
      const result = await api.checkArtifact(artifact.id)
      await refreshIntelligence(selected.id)
      setNotice(`文件检查完成：${ARTIFACT_STATUS_LABELS[result.status]}`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const toggleArchiveArtifact = async (artifact: ArtifactRecord) => {
    if (selected === null) return
    const next = artifact.status === 'archived' ? 'active' : 'archived'
    setArtifactBusy(`status:${artifact.id}`); setError(''); setNotice('')
    try {
      const updated = await api.setArtifactStatus(artifact.id, next)
      await refreshIntelligence(selected.id)
      setNotice(`Artifact 状态已经更新：${ARTIFACT_STATUS_LABELS[updated.status]}`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const openArtifactLocation = async (artifact: ArtifactRecord) => {
    setArtifactBusy(`open:${artifact.id}`); setError(''); setNotice('')
    try { await api.openArtifactLocation(artifact.id); setNotice(`已经打开文件位置：${artifact.name}`) }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const deleteArtifactIndex = async (artifact: ArtifactRecord) => {
    if (selected === null || !window.confirm(`只移除 ${artifact.name} 的 Workbench 索引，磁盘文件不会变化。是否继续？`)) return
    setArtifactBusy(artifact.id); setError(''); setNotice('')
    try {
      await api.deleteArtifact(artifact.id)
      await refreshIntelligence(selected.id)
      setNotice(`Artifact 索引已经移除：${artifact.name}`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setArtifactBusy(null) }
  }

  const closeArtifactDetail = () => {
    setArtifactEvidence(null)
    setArtifactProvenance(null)
    setArtifactAudit(null)
    setArtifactReview(null)
  }

  const artifactDetailTabs = (artifactId: string, active: 'evidence' | 'provenance' | 'audit' | 'review') => <nav className="artifact-detail-tabs" aria-label="Artifact 详情标签">
    <button className={active === 'evidence' ? 'active' : ''} onClick={() => void showArtifactEvidence(artifactId)}>Evidence</button>
    <button className={active === 'provenance' ? 'active' : ''} onClick={() => void showArtifactProvenance(artifactId)}>Provenance</button>
    <button className={active === 'audit' ? 'active' : ''} onClick={() => void auditArtifact(artifactId)}>Audit</button>
    <button className={active === 'review' ? 'active' : ''} onClick={() => void showArtifactReview(artifactId)}>Review</button>
  </nav>

  return <div className="page-stack">
    <header className="page-heading"><div><Badge tone="blue">Project Intelligence</Badge><h1>从项目资产变化中提取状态线索</h1><p>项目分析使用扫描聚合值、任务和 Memory 引用，不执行逐文件差异比较。</p></div></header>

    <Panel title="创建项目" subtitle="目录需要位于路径许可范围，项目类型由顶层结构自动识别。">
      <div className="project-register-grid">
        <label><span>项目路径</span><input aria-label="项目路径" value={rootPath} onChange={event => setRootPath(event.target.value)} /></label>
        <label><span>项目名称</span><input aria-label="项目名称" value={name} onChange={event => setName(event.target.value)} placeholder="留空时使用目录名称" /></label>
        <label className="project-description"><span>项目说明</span><input aria-label="项目说明" value={description} onChange={event => setDescription(event.target.value)} /></label>
        <button className="primary" disabled={busy || rootPath.trim().length === 0} onClick={() => void register()}>{busy ? '正在登记并扫描…' : '登记项目'}</button>
      </div>
      <div className="allowed-root-note"><span>允许根</span>{snapshot.workspaces.allowedRoots.map(root => <code key={root}>{root}</code>)}</div>
      {error && <p className="error-banner">{error}</p>}
      {notice && <p className="success-banner">{notice}</p>}
    </Panel>

    <div className="project-context-layout">
      <Panel title="项目列表" subtitle={`${projects.length} 个已登记项目`} className="project-context-list-panel">
        {projects.length === 0 ? <EmptyState icon="◇" title="尚无 Project Context" detail="输入许可范围内的目录即可建立项目视图。" /> : <div className="context-project-list">
          {projects.map(project => <button key={project.id} className={selected?.id === project.id ? 'active' : ''} onClick={() => setSelectedId(project.id)}>
            <div><strong>{project.name}</strong><Badge tone={project.lastScanAt === null ? 'amber' : 'green'}>{TYPE_LABELS[project.projectType]}</Badge></div>
            <code>{project.rootPath}</code>
            <span><b>{project.assetStats?.fileCount ?? 0}</b> 个文件 · {project.lastScanAt === null ? '尚未扫描' : new Date(project.lastScanAt).toLocaleString()}</span>
          </button>)}
        </div>}
      </Panel>

      <Panel title={selected?.name ?? '项目详情'} subtitle={selected?.description || '选择项目查看资产、任务和 Memory 状态。'} action={selected && <button className="icon-button" disabled={scanningId === selected.id} onClick={() => void scan(selected.id)}>{scanningId === selected.id ? '扫描中…' : '重新扫描'}</button>} className="project-detail-panel">
        {selected === null ? <EmptyState icon="⌂" title="请选择项目" detail="项目详情会显示资产状态、变化和关联任务。" /> : <>
          <div className="project-meta-line"><Badge tone="blue">{TYPE_LABELS[selected.projectType]}</Badge><code>{selected.rootPath}</code><span>更新于 {new Date(selected.updatedAt).toLocaleString()}</span></div>
          <nav className="project-detail-tabs" aria-label="项目详情标签">
            <button className={projectDetailTab === 'overview' ? 'active' : ''} onClick={() => setProjectDetailTab('overview')}>项目概览</button>
            <button className={projectDetailTab === 'evidence' ? 'active' : ''} onClick={() => setProjectDetailTab('evidence')}>Evidence Intelligence</button>
          </nav>
          {projectDetailTab === 'overview' ? <>
          <div className="metric-grid project-metrics intelligence-status-grid">
            <Metric label="当前文件" value={String(selected.assetStats?.fileCount ?? 0)} />
            <Metric label="最近变化" value={changeTitle(selected)} />
            <Metric label="最近扫描" value={selected.lastScanAt === null ? '尚无' : new Date(selected.lastScanAt).toLocaleDateString()} />
            <Metric label="任务数量" value={String(selected.taskCount)} />
          </div>
          <div className="project-detail-grid">
            <div><h3>识别依据</h3><div className="signal-list">{selected.assetStats ? Object.entries(selected.assetStats.detectedSignals).map(([key, value]) => <span key={key} className={value ? 'matched' : ''}>{key.replace(/^has/u, '')}<b>{value ? '✓' : '—'}</b></span>) : <p>完成首次扫描后显示。</p>}</div></div>
            <div><h3>Memory 状态</h3><div className="memory-link-summary"><strong>{selected.memoryReferenceCount}</strong><span>条结构化 Memory 关联</span>{selected.memoryReferences.map(reference => <div className="memory-reference-row" key={reference.id}><code>{reference.memoryRole} · {reference.memoryProjectName}#{reference.memoryEntityId}</code><button aria-label={`移除 Memory ${reference.memoryProjectName}`} disabled={actionBusy !== null} onClick={() => void unlinkMemory(reference.memoryEntityId, reference.memoryRole)}>移除</button></div>)}</div>
              <div className="memory-link-controls"><select aria-label="Memory 项目" value={memoryProjectId} onChange={event => setMemoryProjectId(event.target.value)} disabled={availableMemoryProjects.length === 0}>{availableMemoryProjects.length === 0 ? <option value="">当前数据角色没有可绑定项目</option> : availableMemoryProjects.map(project => <option key={project.id} value={project.id}>{project.name} #{project.id}</option>)}</select><button disabled={memoryProjectId.length === 0 || actionBusy !== null} onClick={() => void linkMemory()}>添加引用</button></div>
            </div>
          </div>
          <div className="recommended-actions"><h3>推荐操作</h3><div className="project-action-buttons">{selected.actions.map(action => <button key={action.action_type} disabled={actionBusy !== null || scanningId !== null} onClick={() => void runAction(action)}>{actionBusy === action.action_type ? '处理中…' : action.label}</button>)}</div></div>
          </> : intelligenceLoading || evidenceHealth === null ? <p className="muted">正在计算 Evidence 健康状态…</p> : <div className="project-evidence-dashboard">
            <div className="metric-grid evidence-health-metrics">
              <Metric label="Artifacts" value={String(evidenceHealth.artifact_count)} />
              <Metric label="Evidence Coverage" value={`${(evidenceHealth.coverage * 100).toFixed(1)}%`} />
              <Metric label="Healthy" value={String(evidenceHealth.health_summary.healthy)} />
              <Metric label="Warning" value={String(evidenceHealth.health_summary.warning)} />
              <Metric label="Broken" value={String(evidenceHealth.health_summary.broken)} />
            </div>
            <div className="evidence-dashboard-section">
              <header><div><h3>Evidence Issue Center</h3><p>{evidenceHealth.issue_count} 项问题，计算时间 {new Date(evidenceHealth.checked_at).toLocaleString()}</p></div><Badge tone={evidenceHealth.health_summary.broken > 0 ? 'red' : evidenceHealth.issue_count > 0 ? 'amber' : 'green'}>{evidenceHealth.issue_count === 0 ? 'Healthy' : 'Needs review'}</Badge></header>
              <EvidenceIssueCenter issues={evidenceHealth.issues} />
            </div>
            <div className="evidence-dashboard-grid">
              <section><h3>Release Readiness</h3><div className="release-readiness-summary"><strong>{evidenceHealth.release_summary.ready}</strong><span>READY</span><strong>{evidenceHealth.release_summary.needs_review}</strong><span>NEEDS_REVIEW</span><strong>{evidenceHealth.release_summary.needs_recheck ?? 0}</strong><span>NEEDS_RECHECK</span><strong>{evidenceHealth.release_summary.rejected}</strong><span>REJECTED</span></div></section>
              <section><h3>Review Overview</h3>{reviewSummary === null ? <p className="muted">正在读取人工审核统计…</p> : <><div className="review-summary-grid"><span><strong>{reviewSummary.pending}</strong>Pending</span><span><strong>{reviewSummary.approved}</strong>Approved</span><span><strong>{reviewSummary.needs_revision}</strong>Needs Revision</span><span><strong>{reviewSummary.needs_recheck ?? 0}</strong>Need Recheck</span><span><strong>{reviewSummary.rejected}</strong>Rejected</span></div><div className="review-identity-card compact"><div><span>Reviewer</span><strong>{reviewSummary.reviewers?.[0]?.name ?? '尚未创建'}</strong></div><div><span>Role</span><strong>{reviewSummary.reviewers?.[0]?.role ?? '—'}</strong></div><div><span>Policy</span><strong>{(reviewSummary.active_policies ?? []).map(item => `${item.policy_type} ${item.version}`).join(' / ')}</strong></div></div></>}</section>
              <section><h3>最近 Audit</h3>{evidenceHealth.recent_audits.length === 0 ? <p className="muted">尚无持久化 Audit 记录。</p> : <div className="recent-audit-list">{evidenceHealth.recent_audits.map(audit => <article key={audit.id}><Badge tone={audit.status === 'healthy' ? 'green' : audit.status === 'warning' ? 'amber' : 'red'}>{audit.status}</Badge><div><strong>{audit.artifact_name}</strong><small>{audit.issues.length} 项问题 · {new Date(audit.created_at).toLocaleString()}</small></div></article>)}</div>}</section>
            </div>
          </div>}
        </>}
      </Panel>
    </div>

    {selected && <div className="project-intelligence-grid">
      <Panel title="最近变化" subtitle="最新扫描与上一次扫描的聚合比较">
        {intelligenceLoading ? <p className="muted">正在读取变化数据…</p> : selected.changeSummary === null ? <EmptyState icon="△" title="尚无可比较记录" detail="再次扫描后会显示文件、容量和扩展名变化。" /> : <div className="change-summary">
          <div><span>文件变化</span><strong>{signedNumber(selected.changeSummary.file_count_change)}</strong><small>新增估算 {selected.changeSummary.added_files_estimate}</small></div>
          <div><span>容量变化</span><strong>{signedBytes(selected.changeSummary.size_change)}</strong><small>比例 {(selected.changeSummary.file_change_ratio * 100).toFixed(2)}%</small></div>
          <div><span>新增扩展名</span><strong>{selected.changeSummary.new_extensions.join('、') || '无'}</strong></div>
          <div><span>移除扩展名</span><strong>{selected.changeSummary.removed_extensions.join('、') || '无'}</strong></div>
        </div>}
        <div className="snapshot-history"><h3>扫描历史</h3>{history.slice(0, 5).map(row => <div key={row.snapshot_id}><time>{new Date(row.scan_time).toLocaleString()}</time><span>{row.file_count} 文件</span><span>{row.directory_count} 目录</span><span>{formatBytes(row.total_bytes)}</span></div>)}</div>
      </Panel>
      <Panel title="项目时间线" subtitle="项目创建、扫描、完成任务、Memory、Artifact 与 Evidence 活动">
        {timeline.length === 0 ? <EmptyState icon="◷" title="暂无项目活动" detail="扫描或完成任务后会生成时间线。" /> : <div className="project-timeline">{timeline.slice(0, 12).map(event => <div key={`${event.timestamp}:${event.source}`}><i /><time>{new Date(event.timestamp).toLocaleString()}</time><Badge tone={event.type === 'task_completed' ? 'green' : event.type === 'memory_linked' ? 'blue' : 'neutral'}>{TIMELINE_LABELS[event.type]}</Badge><strong>{event.title}</strong><code>{event.source}</code></div>)}</div>}
      </Panel>
    </div>}

    {selected && <Panel title="Artifact Intelligence" subtitle="管理产物状态、只读预览与版本关系；数据库继续只保存路径和元数据。">
      <div className="project-artifact-toolbar">
        <label><span>类型筛选</span><select aria-label="Artifact 类型筛选" value={artifactFilter} onChange={event => setArtifactFilter(event.target.value as ArtifactType | '')}><option value="">全部类型</option>{ARTIFACT_TYPES.map(type => <option value={type} key={type}>{type}</option>)}</select></label>
        <label><span>状态筛选</span><select aria-label="Artifact 状态筛选" value={artifactStatusFilter} onChange={event => setArtifactStatusFilter(event.target.value as ArtifactStatus | '')}><option value="">全部状态</option>{ARTIFACT_STATUSES.map(status => <option value={status} key={status}>{ARTIFACT_STATUS_LABELS[status]}</option>)}</select></label>
        <label className="artifact-path-entry"><span>登记已有文件</span><input aria-label="Artifact 文件路径" value={artifactPath} onChange={event => setArtifactPath(event.target.value)} placeholder={`${selected.rootPath}\\output\\report.md`} /></label>
        <label><span>产物类型</span><select aria-label="登记 Artifact 类型" value={artifactRegisterType} onChange={event => setArtifactRegisterType(event.target.value as ArtifactType)}>{ARTIFACT_TYPES.map(type => <option value={type} key={type}>{type}</option>)}</select></label>
        <label><span>替代旧版本</span><select aria-label="Artifact 替代版本" value={artifactSupersedesId} onChange={event => setArtifactSupersedesId(event.target.value)}><option value="">独立产物</option>{artifacts.map(artifact => <option value={artifact.id} key={artifact.id}>{artifact.name}</option>)}</select></label>
        <button className="primary" disabled={artifactBusy !== null || artifactPath.trim().length === 0} onClick={() => void registerArtifact()}>{artifactBusy === 'register' ? '校验与计算中…' : '登记索引'}</button>
      </div>
      <p className="artifact-safety-note">文件必须位于当前项目和路径许可范围内。预览不会执行代码，移除操作只处理 Workbench 索引。</p>
      {artifacts.length === 0 ? <EmptyState icon="□" title="暂无产物。" detail="可以登记已有文件，任务输出候选也可以在任务详情中确认。" /> : <div className="project-artifact-list">{artifacts.map(artifact => <article key={artifact.id}>
        <div className="artifact-kind"><Badge tone={artifact.artifact_type === 'report' ? 'blue' : 'neutral'}>{artifact.artifact_type}</Badge><Badge tone={artifact.status === 'active' ? 'green' : artifact.status === 'missing' ? 'red' : artifact.status === 'outdated' ? 'amber' : 'neutral'}>{ARTIFACT_STATUS_LABELS[artifact.status]}</Badge><small>{artifact.mime_type}</small></div>
        <div><strong>{artifact.name}</strong><code>{artifact.relative_path}</code><small>{artifact.task_id === null ? '项目直接登记' : `来源任务 ${artifact.task_id}`}</small></div>
        <span>{formatBytes(artifact.size_bytes)}<small>{artifact.version_count} 个版本 · {new Date(artifact.created_at).toLocaleString()}</small></span>
        <code className="artifact-hash">{artifact.sha256.slice(0, 16)}…</code>
        <div className="artifact-row-actions"><button disabled={artifactBusy !== null || artifact.status === 'missing'} onClick={() => void previewArtifact(artifact)}>预览</button><button disabled={artifactBusy !== null} onClick={() => void checkArtifact(artifact)}>检查</button><button disabled={artifactBusy !== null} onClick={() => void showArtifactHistory(artifact)}>版本</button><button disabled={artifactBusy !== null} onClick={() => void showArtifactEvidence(artifact.id)}>Evidence</button><button disabled={artifactBusy !== null} onClick={() => void showArtifactProvenance(artifact.id)}>Provenance</button><button disabled={artifactBusy !== null} onClick={() => void showArtifactReview(artifact.id)}>Review</button><button disabled={artifactBusy !== null || artifact.status === 'missing'} onClick={() => void openArtifactLocation(artifact)}>打开位置</button><button disabled={artifactBusy !== null} onClick={() => void toggleArchiveArtifact(artifact)}>{artifact.status === 'archived' ? '恢复' : '归档'}</button><button disabled={artifactBusy !== null} onClick={() => void deleteArtifactIndex(artifact)}>{artifactBusy === artifact.id ? '处理中…' : '移除索引'}</button></div>
      </article>)}</div>}
      {artifactPreview && <section className="artifact-intelligence-detail"><header><div><Badge tone="blue">只读预览</Badge><strong>{artifactPreview.artifact.name}</strong></div><button onClick={() => setArtifactPreview(null)}>关闭</button></header><dl><div><dt>预览类型</dt><dd>{artifactPreview.preview_type}</dd></div><div><dt>MIME</dt><dd>{artifactPreview.mime}</dd></div><div><dt>截断</dt><dd>{artifactPreview.truncated ? '是，最多显示 100KB' : '否'}</dd></div>{artifactPreview.preview_type === 'image' && <><div><dt>宽度</dt><dd>{artifactPreview.width}px</dd></div><div><dt>高度</dt><dd>{artifactPreview.height}px</dd></div></>}</dl>{artifactPreview.content !== null && <pre>{artifactPreview.content}</pre>}</section>}
      {artifactHistory && <section className="artifact-intelligence-detail"><header><div><Badge tone="blue">版本链</Badge><strong>{artifactHistory.version_count} 个版本记录</strong></div><button onClick={() => setArtifactHistory(null)}>关闭</button></header><div className="artifact-version-chain">{artifactHistory.versions.map(version => { const artifact = artifactHistory.artifacts.find(item => item.id === version.artifact_id); return <article key={version.id}><Badge tone="neutral">v{version.version_number}</Badge><div><strong>{artifact?.name ?? version.artifact_id}</strong><code>{artifact?.relative_path ?? '—'}</code><small>{version.change_note || '没有版本说明'}</small></div><code>{version.sha256.slice(0, 16)}…</code></article> })}</div></section>}
      {artifactEvidence && <section className="artifact-intelligence-detail artifact-evidence-detail"><header><div><Badge tone="blue">Evidence</Badge><strong>{artifactEvidence.artifact.name}</strong><span>{artifactEvidence.count} 条关系</span></div><button onClick={closeArtifactDetail}>关闭</button></header>
        {artifactDetailTabs(artifactEvidence.artifact.id, 'evidence')}
        {artifactEvidence.evidence.length === 0 ? <p className="muted">当前没有 Evidence 关系。</p> : <div className="artifact-evidence-list">{artifactEvidence.evidence.map(link => <article key={link.id}><div><Badge tone="neutral">{link.relation_type}</Badge><strong>{link.source.label}</strong><code>{link.source_type}:{link.source_id}</code><small>{link.source.available ? '关联对象可用' : '关联对象当前不可用'}</small></div><button disabled={artifactBusy !== null} onClick={() => void removeArtifactEvidence(link.id)}>移除关系</button></article>)}</div>}
        <div className="artifact-evidence-form"><h4>添加 Evidence 关系</h4><label><span>来源类型</span><select aria-label="Evidence 来源类型" value={evidenceSourceType} onChange={event => setEvidenceSourceType(event.target.value as ArtifactEvidenceSourceType)}>{ARTIFACT_EVIDENCE_SOURCE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}</select></label>{evidenceSourceType === 'memory' && <label><span>Memory 实体</span><select aria-label="Memory 实体类型" value={evidenceMemoryType} onChange={event => setEvidenceMemoryType(event.target.value as MemoryEntityType)}>{(['project', 'decision', 'experiment', 'document', 'task', 'session'] as MemoryEntityType[]).map(type => <option key={type} value={type}>{type}</option>)}</select></label>}<label className="artifact-evidence-source-id"><span>{evidenceSourceType === 'document_chunk' ? 'Chunk UID' : '来源 ID'}</span><input aria-label="Evidence 来源 ID" value={evidenceSourceId} onChange={event => setEvidenceSourceId(event.target.value)} placeholder={evidenceSourceType === 'memory' ? 'Memory 记录 ID' : evidenceSourceType === 'document_chunk' ? '64 位 Chunk UID' : '对应对象 ID'} /></label><label><span>关系</span><select aria-label="Evidence 关系类型" value={evidenceRelationType} onChange={event => setEvidenceRelationType(event.target.value as ArtifactEvidenceRelationType)}>{ARTIFACT_EVIDENCE_RELATION_TYPES.map(type => <option key={type} value={type}>{type}</option>)}</select></label><button className="primary" disabled={artifactBusy !== null || evidenceSourceId.trim().length === 0} onClick={() => void createArtifactEvidence()}>建立关系</button></div>
      </section>}
      {artifactProvenance && <section className="artifact-intelligence-detail artifact-provenance-detail"><header><div><Badge tone="blue">Provenance</Badge><strong>{artifactProvenance.nodes.find(node => node.id === `artifact:${artifactProvenance.artifact_id}`)?.title ?? artifactProvenance.artifact_id}</strong><span>{artifactProvenance.nodes.length} 个节点 · {artifactProvenance.edges.length} 条关系</span></div><button onClick={closeArtifactDetail}>关闭</button></header>
        {artifactDetailTabs(artifactProvenance.artifact_id, 'provenance')}
        <ProvenanceGraph graph={artifactProvenance} />
        <div className="provenance-relation-list">{artifactProvenance.edges.map(edge => <article key={edge.evidence_id}><code>{edge.source}</code><Badge tone="neutral">{edge.relation_type}</Badge><code>{edge.target}</code></article>)}</div>
        <div className="provenance-actions"><button onClick={() => void auditArtifact(artifactProvenance.artifact_id)}>执行 Evidence 审计</button><button className="primary" onClick={() => void exportArtifactProvenance(artifactProvenance.artifact_id)}>导出 artifact-provenance.json</button></div>
      </section>}
      {artifactAudit && <section className="artifact-intelligence-detail artifact-audit-detail"><header><div><Badge tone={artifactAudit.status === 'healthy' ? 'green' : artifactAudit.status === 'warning' ? 'amber' : 'red'}>Audit · {artifactAudit.status}</Badge><strong>{artifacts.find(item => item.id === artifactAudit.artifact_id)?.name ?? artifactAudit.artifact_id}</strong><span>{artifactAudit.issues.length} 项问题</span></div><button onClick={closeArtifactDetail}>关闭</button></header>
        {artifactDetailTabs(artifactAudit.artifact_id, 'audit')}
        <dl><div><dt>检查时间</dt><dd>{new Date(artifactAudit.checked_at).toLocaleString()}</dd></div><div><dt>Evidence 数量</dt><dd>{artifactAudit.evidence_count}</dd></div><div><dt>Audit ID</dt><dd><code>{artifactAudit.audit_id ?? '未保存'}</code></dd></div></dl>
        {artifactAudit.issues.length === 0 ? <EmptyState icon="✓" title="Evidence 审计通过" detail="已登记来源均可读取，Artifact 状态与版本关系没有发现问题。" /> : <div className="artifact-audit-issues">{artifactAudit.issues.map((issue, index) => <article key={`${issue.code}:${issue.evidence_id ?? index}`}><Badge tone={issue.severity === 'broken' ? 'red' : 'amber'}>{issue.severity}</Badge><div><strong>{issue.code}</strong><p>{issue.message}</p>{issue.source_id && <code>{issue.source_type}:{issue.source_id}</code>}</div></article>)}</div>}
      </section>}
      {artifactReview && <section className="artifact-intelligence-detail artifact-review-detail"><header><div><Badge tone={artifactReview.current_decision === 'approved' ? 'green' : artifactReview.current_decision === 'rejected' ? 'red' : artifactReview.current_decision === 'needs_revision' ? 'amber' : 'neutral'}>Review · {artifactReview.current_decision}</Badge><strong>{artifactReview.artifact.name}</strong><span>{artifactReview.count} 条人工记录</span></div><button onClick={closeArtifactDetail}>关闭</button></header>
        {artifactDetailTabs(artifactReview.artifact.id, 'review')}
        {artifactReview.current_signature && <div className="artifact-signature-banner"><Badge tone={artifactReview.current_signature.status === 'VALID' ? 'green' : 'red'}>Signature {artifactReview.current_signature.status}</Badge><span>{artifactReview.current_signature.policy_type ?? '—'} {artifactReview.current_signature.policy_version ?? ''}</span><span>{artifactReview.current_signature.needs_recheck ? '需要重新审核' : '当前快照未触发重新审核'}</span></div>}
        <div className="artifact-review-form"><label><span>Reviewer</span><select aria-label="Artifact 审核人" value={reviewerId} onChange={event => setReviewerId(event.target.value)}><option value="">请先在 Review Queue 创建身份</option>{(reviewSummary?.reviewers ?? []).map(item => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label><label><span>Policy</span><select aria-label="Artifact 审核策略" value={reviewPolicyType} onChange={event => setReviewPolicyType(event.target.value as ReviewPolicyType)}>{(reviewSummary?.active_policies ?? []).map(item => <option key={item.id} value={item.policy_type}>{item.policy_type} · {item.version}</option>)}</select></label><label><span>审核备注</span><textarea aria-label="Artifact 审核备注" value={reviewNote} maxLength={2000} onChange={event => setReviewNote(event.target.value)} placeholder="记录批准、拒绝或修订依据" /></label><div><button disabled={artifactBusy !== null || reviewerId.length === 0} onClick={() => void submitArtifactReview('pending')}>保留待审</button><button disabled={artifactBusy !== null || reviewerId.length === 0} onClick={() => void submitArtifactReview('needs_revision')}>需要修订</button><button disabled={artifactBusy !== null || reviewerId.length === 0} onClick={() => void submitArtifactReview('rejected')}>拒绝</button><button className="primary" disabled={artifactBusy !== null || reviewerId.length === 0} onClick={() => void submitArtifactReview('approved')}>批准并签名</button></div></div>
        {artifactReview.history.length === 0 ? <EmptyState icon="◷" title="尚无人工审核记录" detail="首次提交后会保留审核人、判断、快照哈希、Policy版本和时间。" /> : <div className="artifact-review-history">{artifactReview.history.map(record => <article key={record.id}><Badge tone={record.decision === 'approved' ? 'green' : record.decision === 'rejected' ? 'red' : record.decision === 'needs_revision' ? 'amber' : 'neutral'}>{record.decision}</Badge><div><strong>{record.reviewer}</strong><p>{record.note || '没有审核备注。'}</p><small>{record.policy_type ?? 'legacy'} {record.policy_version ?? ''} · {new Date(record.created_at).toLocaleString()}</small></div></article>)}</div>}
      </section>}
    </Panel>}

    {selected && <div className="dashboard-grid">
      <Panel title="最近任务" subtitle="新任务会根据输入路径自动关联项目">
        {selected.recentTasks.length === 0 ? <EmptyState icon="◷" title="暂无关联任务" detail="从该项目目录创建文件或资产任务后会显示在这里。" /> : <div className="recent-list">{selected.recentTasks.map(task => <button key={task.id} onClick={() => onOpenTask(task.id)}><span><strong>{task.title}</strong><small>{task.templateId} · {new Date(task.createdAt).toLocaleString()}</small></span><Badge tone={task.status === 'completed' ? 'green' : task.status === 'failed' ? 'red' : 'neutral'}>{task.status}</Badge></button>)}</div>}
      </Panel>
      <Panel title="最近修改文件" subtitle="来自最新资产扫描，只保存路径、大小和修改时间">
        {selected.assetStats === null ? <EmptyState icon="◇" title="尚无扫描结果" detail="点击重新扫描生成资产统计。" /> : <ul className="file-list">{selected.assetStats.recentFiles.slice(0, 7).map(file => <li key={file.path}><code>{file.path}</code><span>{new Date(file.modifiedAt).toLocaleString()}</span></li>)}</ul>}
      </Panel>
    </div>}
  </div>
}
