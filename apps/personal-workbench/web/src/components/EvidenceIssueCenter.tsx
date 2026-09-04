import type { ProjectEvidenceHealthIssue } from '../../../shared/contracts/index.ts'
import { Badge, EmptyState } from './common.tsx'

const LABELS: Record<ProjectEvidenceHealthIssue['severity'], string> = {
  broken: 'Broken',
  warning: 'Warning',
  missing: 'Missing',
}

export function EvidenceIssueCenter({ issues }: { issues: ProjectEvidenceHealthIssue[] }): JSX.Element {
  if (issues.length === 0) {
    return <EmptyState icon="✓" title="当前没有 Evidence 问题" detail="项目中的 Artifact 已通过即时来源检查。" />
  }
  return <div className="evidence-issue-center">
    {issues.map((issue, index) => <article key={`${issue.artifact_id}:${issue.code}:${index}`}>
      <Badge tone={issue.severity === 'broken' ? 'red' : issue.severity === 'warning' ? 'amber' : 'neutral'}>{LABELS[issue.severity]}</Badge>
      <div>
        <strong>{issue.artifact_name}</strong>
        <p>{issue.issue}</p>
        <code>{issue.code} · {issue.artifact_id}</code>
      </div>
      <time>{new Date(issue.created_at).toLocaleString()}</time>
    </article>)}
  </div>
}
