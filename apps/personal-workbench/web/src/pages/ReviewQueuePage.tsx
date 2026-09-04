import { useEffect, useMemo, useState } from 'react'
import type {
  ProjectReviewQueue,
  ProjectReviewSummary,
  ReviewDecision,
  ReviewerProfile,
  ReviewerRole,
  ReviewPolicy,
  ReviewPolicyType,
} from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import type { AppSnapshot } from '../app/types.ts'
import { Badge, EmptyState, Metric, Panel } from '../components/common.tsx'

const DECISION_LABELS: Record<ReviewDecision, string> = {
  pending: '待审核',
  approved: '已批准',
  rejected: '已拒绝',
  needs_revision: '需要修订',
}

export function ReviewQueuePage({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [projectId, setProjectId] = useState(snapshot.projectContexts[0]?.id ?? '')
  const [queue, setQueue] = useState<ProjectReviewQueue | null>(null)
  const [summary, setSummary] = useState<ProjectReviewSummary | null>(null)
  const [reviewers, setReviewers] = useState<ReviewerProfile[]>([])
  const [policies, setPolicies] = useState<ReviewPolicy[]>([])
  const [reviewerId, setReviewerId] = useState('')
  const [policyType, setPolicyType] = useState<ReviewPolicyType>('research')
  const [newReviewerName, setNewReviewerName] = useState('本地审核人')
  const [newReviewerRole, setNewReviewerRole] = useState<ReviewerRole>('research_reviewer')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const selectedProject = useMemo(() => snapshot.projectContexts.find(item => item.id === projectId) ?? null, [snapshot.projectContexts, projectId])

  useEffect(() => {
    if (!snapshot.projectContexts.some(item => item.id === projectId)) setProjectId(snapshot.projectContexts[0]?.id ?? '')
  }, [snapshot.projectContexts, projectId])

  const refresh = async (id = projectId) => {
    if (id.length === 0) { setQueue(null); setSummary(null); return }
    setBusy('load'); setError('')
    try {
      const [nextQueue, nextSummary, nextReviewers, nextPolicies] = await Promise.all([
        api.projectReviews(id), api.projectReviewSummary(id), api.reviewers(), api.reviewPolicies(),
      ])
      setQueue(nextQueue)
      setSummary(nextSummary)
      const reviewerRows = Array.isArray(nextReviewers) ? nextReviewers : []
      const policyRows = Array.isArray(nextPolicies) ? nextPolicies : []
      setReviewers(reviewerRows)
      setPolicies(policyRows)
      if (!reviewerRows.some(item => item.id === reviewerId)) setReviewerId(reviewerRows[0]?.id ?? '')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(null) }
  }

  useEffect(() => { void refresh(projectId) }, [projectId])

  const submit = async (artifactId: string, decision: ReviewDecision) => {
    setBusy(`${artifactId}:${decision}`); setError('')
    try {
      const resolvedReviewerId = reviewerId || (await api.createReviewer({ name: newReviewerName, role: newReviewerRole })).id
      setReviewerId(resolvedReviewerId)
      await api.submitArtifactReview(artifactId, { decision, reviewer_id: resolvedReviewerId, policy_type: policyType, note: notes[artifactId] ?? '' })
      await refresh()
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setBusy(null) }
  }

  const createReviewer = async () => {
    setBusy('create-reviewer'); setError('')
    try {
      const created = await api.createReviewer({ name: newReviewerName, role: newReviewerRole })
      const next = await api.reviewers()
      setReviewers(next)
      setReviewerId(created.id)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(null) }
  }

  const activeReviewer = reviewers.find(item => item.id === reviewerId) ?? null
  const activePolicy = policies.find(item => item.policy_type === policyType) ?? null

  return <div className="page-stack review-queue-page">
    <header className="page-heading"><div><Badge tone="blue">Human Approval Gate</Badge><h1>Evidence Review Queue</h1><p>队列集中显示需要人工判断的 Artifact。提交操作只会追加审核记录，不会改写 Artifact、Evidence 或来源数据。</p></div></header>

    <Panel title="审核范围" subtitle="Reviewer Identity 和 Review Policy 均保存在本机 Workbench 数据库。">
      <div className="review-queue-toolbar">
        <label><span>项目</span><select aria-label="审核项目" value={projectId} onChange={event => setProjectId(event.target.value)}>{snapshot.projectContexts.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label><span>Reviewer</span><select aria-label="审核人" value={reviewerId} onChange={event => setReviewerId(event.target.value)}><option value="">请选择本地身份</option>{reviewers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label>
        <label><span>Policy</span><select aria-label="审核策略" value={policyType} onChange={event => setPolicyType(event.target.value as ReviewPolicyType)}>{policies.map(item => <option key={item.id} value={item.policy_type}>{item.policy_type} · {item.version}</option>)}</select></label>
        <button disabled={busy !== null || projectId.length === 0} onClick={() => void refresh()}>{busy === 'load' ? '正在读取…' : '刷新队列'}</button>
      </div>
      {reviewers.length === 0 && <div className="reviewer-create-row"><input aria-label="新审核人名称" value={newReviewerName} maxLength={128} onChange={event => setNewReviewerName(event.target.value)} /><select aria-label="新审核人角色" value={newReviewerRole} onChange={event => setNewReviewerRole(event.target.value as ReviewerRole)}><option value="reviewer">reviewer</option><option value="lead_reviewer">lead_reviewer</option><option value="research_reviewer">research_reviewer</option><option value="code_reviewer">code_reviewer</option><option value="knowledge_reviewer">knowledge_reviewer</option></select><button disabled={busy !== null || newReviewerName.trim().length === 0} onClick={() => void createReviewer()}>创建本地身份</button></div>}
      <div className="review-identity-card" aria-label="Reviewer Identity Card"><div><span>Reviewer</span><strong>{activeReviewer?.name ?? '尚未选择'}</strong></div><div><span>Role</span><strong>{activeReviewer?.role ?? '—'}</strong></div><div><span>Policy</span><strong>{activePolicy === null ? '—' : `${activePolicy.policy_type} ${activePolicy.version}`}</strong></div><div><span>存储范围</span><strong>仅限本机</strong></div></div>
      {error && <p className="error-banner">{error}</p>}
    </Panel>

    {summary && <section className="review-overview" aria-label="Review Overview">
      <Metric label="Pending" value={String(summary.pending)} />
      <Metric label="Approved" value={String(summary.approved)} />
      <Metric label="Needs Revision" value={String(summary.needs_revision)} />
      <Metric label="Rejected" value={String(summary.rejected)} />
      <Metric label="Need Recheck" value={String(summary.needs_recheck ?? 0)} />
      <Metric label="Queue" value={String(summary.queue_count)} />
    </section>}

    <Panel title="待处理队列" subtitle={selectedProject === null ? '尚未选择项目' : `${selectedProject.name} · ${queue?.count ?? 0} 项`}>
      {queue === null || busy === 'load' ? <p className="muted">正在读取审核队列…</p> : queue.reviews.length === 0 ? <EmptyState icon="✓" title="当前没有待处理项" detail="已批准且结构检查通过的 Artifact 不会出现在队列中。" /> : <div className="review-queue-list">
        {queue.reviews.map(item => <article key={item.artifact_id}>
          <header><div><Badge tone={item.severity === 'broken' ? 'red' : item.severity === 'warning' || item.severity === 'missing' ? 'amber' : 'blue'}>{item.severity}</Badge><strong>{item.artifact_name}</strong><small>{item.artifact_type}</small></div><Badge tone={item.current_decision === 'approved' ? 'green' : item.current_decision === 'rejected' ? 'red' : item.current_decision === 'needs_revision' ? 'amber' : 'neutral'}>{DECISION_LABELS[item.current_decision]}</Badge></header>
          <p>{item.issue}</p>
          <dl><div><dt>Evidence</dt><dd>{item.evidence_status}</dd></div><div><dt>Audit</dt><dd>{item.audit_status}</dd></div><div><dt>Release</dt><dd>{item.release_status}</dd></div><div><dt>Signature</dt><dd className={item.signature_status === 'VALID' ? 'signature-valid' : 'signature-invalid'}>{item.signature_status}</dd></div><div><dt>Policy</dt><dd>{item.policy_type ?? '—'} {item.policy_version ?? ''}</dd></div><div><dt>失效记录</dt><dd>{item.invalidation_count}</dd></div><div><dt>更新时间</dt><dd>{new Date(item.updated_at).toLocaleString()}</dd></div></dl>
          <label><span>审核备注</span><textarea aria-label={`${item.artifact_name} 审核备注`} value={notes[item.artifact_id] ?? ''} maxLength={2000} onChange={event => setNotes(current => ({ ...current, [item.artifact_id]: event.target.value }))} placeholder="记录判断依据或需要修订的内容" /></label>
          <div className="review-decision-actions"><button disabled={busy !== null || (reviewerId.length === 0 && newReviewerName.trim().length === 0)} onClick={() => void submit(item.artifact_id, 'pending')}>保留待审</button><button disabled={busy !== null || (reviewerId.length === 0 && newReviewerName.trim().length === 0)} onClick={() => void submit(item.artifact_id, 'needs_revision')}>需要修订</button><button disabled={busy !== null || (reviewerId.length === 0 && newReviewerName.trim().length === 0)} onClick={() => void submit(item.artifact_id, 'rejected')}>拒绝</button><button className="primary" disabled={busy !== null || (reviewerId.length === 0 && newReviewerName.trim().length === 0)} onClick={() => void submit(item.artifact_id, 'approved')}>批准</button></div>
        </article>)}
      </div>}
    </Panel>
  </div>
}
