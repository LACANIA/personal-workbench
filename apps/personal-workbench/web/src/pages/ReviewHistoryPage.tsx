import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ProjectReviewHistory,
  ReviewDecision,
  ReviewerProfile,
  ReviewPolicy,
  ReviewPolicyType,
} from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import type { AppSnapshot } from '../app/types.ts'
import { Badge, EmptyState, Metric, Panel } from '../components/common.tsx'

const DECISIONS: Array<{ id: ReviewDecision; label: string }> = [
  { id: 'approved', label: '批准当前快照' },
  { id: 'needs_revision', label: '需要修订' },
  { id: 'rejected', label: '拒绝' },
]

function shortHash(value: string | null): string { return value === null ? '—' : `${value.slice(0, 12)}…` }

export function ReviewHistoryPage({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [projectId, setProjectId] = useState(snapshot.projectContexts[0]?.id ?? '')
  const [history, setHistory] = useState<ProjectReviewHistory | null>(null)
  const [selectedArtifactId, setSelectedArtifactId] = useState('')
  const [reviewers, setReviewers] = useState<ReviewerProfile[]>([])
  const [policies, setPolicies] = useState<ReviewPolicy[]>([])
  const [reviewerId, setReviewerId] = useState('')
  const [policyType, setPolicyType] = useState<ReviewPolicyType>('research')
  const [decision, setDecision] = useState<ReviewDecision>('approved')
  const [note, setNote] = useState('已查看 Artifact 与 Evidence 差异，同意以当前快照重新审核。')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    if (projectId.length === 0) return
    setBusy(true)
    try {
      const [nextHistory, nextReviewers, nextPolicies] = await Promise.all([
        api.projectReviewHistory(projectId), api.reviewers(), api.reviewPolicies(),
      ])
      setHistory(nextHistory)
      setReviewers(nextReviewers)
      setPolicies(nextPolicies)
      setReviewerId(current => current || nextReviewers[0]?.id || '')
      const preferred = nextHistory.artifacts.find(item => item.change_report.release_status === 'NEEDS_RECHECK') ?? nextHistory.artifacts[0]
      setSelectedArtifactId(current => nextHistory.artifacts.some(item => item.artifact.id === current) ? current : preferred?.artifact.id ?? '')
      setMessage('')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }, [projectId])

  useEffect(() => { void load() }, [load])
  const selected = useMemo(() => history?.artifacts.find(item => item.artifact.id === selectedArtifactId) ?? null, [history, selectedArtifactId])

  async function recheck(): Promise<void> {
    if (selected === null || reviewerId.length === 0) return
    setBusy(true)
    try {
      const result = await api.recheckArtifactReview(selected.artifact.id, { decision, reviewer_id: reviewerId, policy_type: policyType, note })
      setMessage(`重新审核已完成：${result.release.status}`)
      await load()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  return <div className="page-stack review-history-page">
    <header className="page-heading"><div><Badge tone="blue">Review History</Badge><h1>审核变化与重新审核</h1><p>按时间查看首次审核、快照变化和重新审核，正文差异只来自受限本机快照。</p></div></header>
    <Panel title="项目审核概览" subtitle="历史记录、失效记录和重新审核记录全部保留">
      <div className="review-history-toolbar"><label><span>Project Context</span><select value={projectId} onChange={event => setProjectId(event.target.value)}>{snapshot.projectContexts.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button onClick={() => void load()} disabled={busy}>刷新</button></div>
      {history && <div className="review-history-metrics"><Metric label="已审核 Artifact" value={history.artifacts.length} /><Metric label="首次审核" value={history.initial_review_count} /><Metric label="变化事件" value={history.change_event_count} /><Metric label="重新审核" value={history.recheck_count} /></div>}
    </Panel>
    {message && <div className="review-history-message">{message}</div>}
    {history === null || busy && history === null ? <Panel title="审核记录"><p className="muted">正在读取审核历史…</p></Panel> : history.artifacts.length === 0 ? <Panel title="审核记录"><EmptyState icon="◷" title="暂无审核记录" detail="该项目还没有人工审核快照。" /></Panel> : <div className="review-history-layout">
      <Panel title="Artifact" subtitle="选择需要查看的成果对象"><div className="review-history-artifacts">{history.artifacts.map(item => <button key={item.artifact.id} className={selectedArtifactId === item.artifact.id ? 'active' : ''} onClick={() => setSelectedArtifactId(item.artifact.id)}><span><strong>{item.artifact.name}</strong><small>{item.artifact.artifact_type} · {item.review_count} 条审核</small></span><Badge tone={item.change_report.release_status === 'READY' ? 'green' : item.change_report.release_status === 'NEEDS_RECHECK' ? 'amber' : 'neutral'}>{item.change_report.release_status}</Badge></button>)}</div></Panel>
      {selected && <div className="review-history-detail">
        <Panel title="Change Reason" subtitle="旧审核快照与当前状态的比较">
          <div className="review-snapshot-grid"><article><span>Old Snapshot</span><code>{shortHash(selected.change_report.old_snapshot.artifact_hash)}</code><small>{selected.change_report.old_snapshot.captured_at ? new Date(selected.change_report.old_snapshot.captured_at).toLocaleString() : '没有快照时间'}</small></article><article><span>New Snapshot</span><code>{shortHash(selected.change_report.new_snapshot.artifact_hash)}</code><small>{new Date(selected.change_report.generated_at).toLocaleString()}</small></article></div>
          <div className="review-change-reasons">{selected.change_report.changed_reasons.length === 0 ? <p>当前签名没有新的失效原因。</p> : selected.change_report.changed_reasons.map(reason => <Badge key={reason} tone="amber">{reason}</Badge>)}</div>
          <ul>{selected.change_report.impact.map(item => <li key={item}>{item}</li>)}</ul>
        </Panel>
        <Panel title="Artifact Diff" subtitle={`${selected.change_report.artifact_diff.snapshot_kind ?? 'unknown'} · ${selected.change_report.artifact_diff.impact_scope}`}>
          <div className="diff-summary"><span>+{selected.change_report.artifact_diff.added_lines}</span><span>−{selected.change_report.artifact_diff.removed_lines}</span><span>{selected.change_report.artifact_diff.note}</span></div>
          {selected.change_report.artifact_diff.changes.length === 0 ? <p className="muted">没有可显示的逐行差异。</p> : <div className="review-diff-view">{selected.change_report.artifact_diff.changes.map((line, index) => <div key={`${line.kind}-${index}`} className={`diff-${line.kind}`}><b>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</b><em>{line.old_line ?? ''}</em><em>{line.new_line ?? ''}</em><code>{line.content}</code></div>)}</div>}
        </Panel>
        <Panel title="Evidence Diff" subtitle={selected.change_report.evidence_diff.note}><div className="evidence-diff-grid">{(['added', 'removed', 'invalidated', 'restored', 'metadata_changed', 'summary_changed'] as const).map(key => <article key={key}><span>{key}</span><strong>{selected.change_report.evidence_diff[key].length}</strong>{selected.change_report.evidence_diff[key].slice(0, 3).map(item => <code key={item.key}>{item.source_type}:{item.source_id}</code>)}</article>)}</div></Panel>
        <Panel title="Review Timeline" subtitle="首次审核、变化与重新审核"><div className="review-timeline">{selected.timeline.map(event => <article key={event.id}><i /><time>{new Date(event.timestamp).toLocaleString()}</time><div><strong>{event.title}</strong><p>{event.decision ?? event.reason ?? '记录'}</p><small>{event.reviewer ?? ''}</small></div></article>)}</div></Panel>
        {selected.change_report.release_status === 'NEEDS_RECHECK' && <Panel title="Recheck Review" subtitle="提交新的人工判断并生成当前快照签名"><div className="recheck-form"><label><span>Reviewer</span><select value={reviewerId} onChange={event => setReviewerId(event.target.value)}>{reviewers.map(reviewer => <option key={reviewer.id} value={reviewer.id}>{reviewer.name} · {reviewer.role}</option>)}</select></label><label><span>Policy</span><select value={policyType} onChange={event => setPolicyType(event.target.value as ReviewPolicyType)}>{policies.map(policy => <option key={policy.id} value={policy.policy_type}>{policy.policy_type} {policy.version}</option>)}</select></label><label><span>Decision</span><select value={decision} onChange={event => setDecision(event.target.value as ReviewDecision)}>{DECISIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label className="recheck-note"><span>人工说明</span><textarea value={note} maxLength={2000} onChange={event => setNote(event.target.value)} /></label><button className="primary" disabled={busy || reviewerId.length === 0} onClick={() => void recheck()}>Recheck Review</button></div></Panel>}
      </div>}
    </div>}
  </div>
}
