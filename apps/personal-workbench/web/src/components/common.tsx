import type { ReactNode } from 'react'

export function StatusDot({ status }: { status: 'ok' | 'warning' | 'error' | string }): JSX.Element {
  return <span className={`status-dot status-${status}`} aria-label={status} />
}

export function Panel({ title, subtitle, action, children, className = '' }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }): JSX.Element {
  return <section className={`panel ${className}`}>
    <header className="panel-header">
      <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      {action}
    </header>
    {children}
  </section>
}

export function EmptyState({ icon, title, detail }: { icon: string; title: string; detail: string }): JSX.Element {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{detail}</p></div>
}

export function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string }): JSX.Element {
  return <div className="metric"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }): JSX.Element {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(2)} GiB`
}

export function formatDuration(start: string | null, end: string | null): string {
  if (start === null) return '—'
  const finish = end === null ? Date.now() : Date.parse(end)
  return `${((finish - Date.parse(start)) / 1000).toFixed(1)} 秒`
}
