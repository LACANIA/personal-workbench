import { useEffect, useState } from 'react'
import type { InputAssetView } from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import { Badge, EmptyState, formatBytes, Panel } from '../components/common.tsx'

type Mode = 'light' | 'smart' | 'project'
type Operation = { id: string; type: 'mkdir' | 'move' | 'rename'; source_relative_path?: string; destination_relative_path: string; reason: string; status: string; error?: string }
type PendingConfirmation = { source_relative_path:string; file_type:string; reason:string }
type Plan = { id: string; root_path: string; mode: Mode; status: string; operations: Operation[]; scan: { file_count?: number; directory_count?: number; total_bytes?: number; duplicates?: string[][]; project_roots?: string[]; truncated?: boolean; needs_confirmation?:PendingConfirmation[] } }
type Rule = { id: string; pattern: string; destination_relative_path: string }

function friendly(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  if (value.includes('ORGANIZER_SYSTEM_DIRECTORY_DENIED')) return '这个目录属于 Windows 系统或应用安装范围，不能整理。'
  if (value.includes('ORGANIZER_DIRECTORY_GRANT_REQUIRED') || value.includes('INPUT_GRANT_EXPIRED')) return '需要通过系统窗口重新选择文件夹，才能继续整理。'
  if (value.includes('SOURCE_CHANGED')) return '有文件在生成计划后发生变化，系统已跳过它。'
  if (value.includes('DESTINATION_EXISTS')) return '目标位置已经存在同名文件，系统没有覆盖它。'
  if (value.includes('UNDO_REAUTHORIZATION_REQUIRED')) return '为了确认操作范围，请重新选择当时整理的文件夹。'
  if (value.includes('UNDO_ROOT_MISMATCH')) return '你选择的文件夹与这次整理的原始目录不一致，系统没有执行撤销。'
  if (value.includes('UNDO_SOURCE_CHANGED')) return '有文件在整理后发生变化，系统没有强行撤销该文件。'
  return value
}

function operationLabel(operation: Operation): string {
  if (operation.type === 'mkdir') return `创建文件夹：${operation.destination_relative_path}`
  return `${operation.source_relative_path ?? ''} → ${operation.destination_relative_path}`
}

export function FileOrganizerPage(): JSX.Element {
  const [asset, setAsset] = useState<InputAssetView | null>(null)
  const [mode, setMode] = useState<Mode>('light')
  const [optimize, setOptimize] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [history, setHistory] = useState<Plan[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [rulePattern, setRulePattern] = useState('')
  const [ruleDestination, setRuleDestination] = useState('')
  const [pendingSelection, setPendingSelection] = useState<Set<string>>(new Set())
  const [pendingDestination, setPendingDestination] = useState('')

  const loadHistory = async () => {
    try { setHistory(await api.organizerHistory() as unknown as Plan[]) } catch { /* history is supplementary UI */ }
  }
  const loadRules = async () => { try { setRules(await api.organizerRules() as unknown as Rule[]) } catch { /* optional configuration */ } }
  useEffect(() => { void loadHistory(); void loadRules() }, [])
  const createRule = async () => {
    if (rulePattern.trim().length === 0 || ruleDestination.trim().length === 0) return
    setBusy(true); setError('')
    try { await api.createOrganizerRule({ pattern: rulePattern, destination_relative_path: ruleDestination }); setRulePattern(''); setRuleDestination(''); setMessage('本地整理规则已保存，下一次扫描会优先采用它。'); await loadRules() }
    catch (caught) { setError(friendly(caught)) } finally { setBusy(false) }
  }

  const choose = async () => {
    setBusy(true); setError(''); setMessage('正在打开 Windows 文件夹选择窗口，请查看前台窗口或任务栏。')
    try {
      const result = await api.selectDirectory()
      if (result.canceled) { setMessage('已经取消选择。'); return }
      if (result.asset !== null) { setAsset(result.asset); setPlan(null); setSelected(new Set()); setMessage('已获得此文件夹的本次整理访问范围。') }
    } catch (caught) { setError(friendly(caught)) } finally { setBusy(false) }
  }
  const scan = async () => {
    if (asset === null) return
    setBusy(true); setError(''); setMessage('')
    try { const next = await api.organizerScan({ input_asset_id: asset.asset.id, mode, optimize_names: optimize }) as unknown as Plan; setPlan(next); setSelected(new Set(next.operations.filter(item => item.type !== 'mkdir' && item.status === 'pending').map(item => item.id))); setMessage('整理建议已经生成。执行前文件尚未发生任何变化。'); await loadHistory() }
    catch (caught) { setError(friendly(caught)) } finally { setBusy(false) }
  }
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const editDestination = async (operation: Operation) => {
    if (plan === null) return
    const current = operation.destination_relative_path.split(/[\\/]/u).slice(0, -1).join('/')
    const destination = window.prompt('输入文件夹内的相对目标目录，例如：课程资料/高数', current)
    if (destination === null) return
    setBusy(true); setError('')
    try { const updated = await api.editOrganizerOperation(plan.id, operation.id, destination) as unknown as Plan; setPlan(updated); setMessage('已调整建议目录，执行时仍会检查范围和文件变化。') } catch (caught) { setError(friendly(caught)) } finally { setBusy(false) }
  }
  const applyPendingDestination = async () => {
    if (plan === null || pendingDestination.trim().length === 0 || pendingSelection.size === 0) return
    setBusy(true); setError('')
    try { const updated = await api.addOrganizerPending(plan.id, [...pendingSelection].map(source_relative_path => ({ source_relative_path, destination_relative_path: pendingDestination }))) as unknown as Plan; setPlan(updated); setPendingSelection(new Set()); setPendingDestination(''); setMessage('已把你确认的项目加入整理计划，执行前仍需确认。') } catch (caught) { setError(friendly(caught)) } finally { setBusy(false) }
  }
  const execute = async () => {
    if (plan === null) return
    const moving = plan.operations.filter(item => item.type !== 'mkdir' && selected.has(item.id)).length
    if (!window.confirm(`即将创建文件夹并移动 ${moving} 个文件。不会删除文件，也不会覆盖同名文件。确认执行吗？`)) return
    setBusy(true); setError('')
    try { await api.approveOrganizerPlan(plan.id, [...selected]); const completed = await api.executeOrganizerPlan(plan.id) as unknown as Plan; setPlan(completed); setMessage(completed.status === 'completed' ? '整理已完成。没有删除或覆盖任何文件。' : '整理已经结束，部分项目需要查看原因。'); await loadHistory() }
    catch (caught) { setError(friendly(caught)) } finally { setBusy(false) }
  }
  const undo = async () => {
    if (plan === null || !window.confirm('为了撤销这次整理，需要重新选择原来的文件夹；系统会核对目录和文件后再恢复。确认继续吗？')) return
    setBusy(true); setError(''); setMessage('正在打开 Windows 文件夹选择窗口，请重新选择当时整理的同一个文件夹。')
    try {
      const selectedRoot = await api.selectDirectory()
      if (selectedRoot.canceled || selectedRoot.asset === null) { setMessage('已经取消重新授权，尚未执行撤销。'); return }
      const next = await api.undoOrganizerPlan(plan.id, selectedRoot.asset.asset.id) as unknown as Plan
      setPlan(next); setMessage('已完成可逆文件移动的撤销。遇到同名冲突或已修改文件的项目会保持原样。'); await loadHistory()
    }
    catch (caught) { setError(friendly(caught)) } finally { setBusy(false) }
  }
  const pending = plan?.operations.filter(item => item.type !== 'mkdir' && item.status === 'pending').length ?? 0
  const directories = plan?.operations.filter(item => item.type === 'mkdir' && item.status === 'pending').length ?? 0
  return <div className="page-stack organizer-page">
    <header className="page-heading"><div><Badge tone="green">本机文件整理</Badge><h1>整理文件</h1><p>先扫描和预览；只有你确认后，系统才会在所选文件夹内创建目录或移动文件。</p></div></header>
    <Panel title="选择一个文件夹" subtitle="系统只能访问你通过 Windows 文件夹选择窗口明确授权的目录树。">
      <div className="universal-input-actions"><button className="primary" type="button" disabled={busy} onClick={() => void choose()}>{asset === null ? '选择文件夹' : '重新选择文件夹'}</button>{asset !== null && <span>{asset.asset.display_name} · 本次任务范围</span>}</div>
      <div className="organizer-options"><label>整理方式<select value={mode} disabled={busy || asset === null} onChange={event => setMode(event.target.value as Mode)}><option value="light">轻度整理（推荐）</option><option value="smart">智能整理</option><option value="project">项目整理</option></select></label><label><input type="checkbox" checked={optimize} disabled={busy || asset === null} onChange={event => setOptimize(event.target.checked)} /> 优化文件名</label><button type="button" className="primary" disabled={busy || asset === null} onClick={() => void scan()}>{busy ? '正在处理…' : '扫描并生成建议'}</button></div>
      <p className="subtle">轻度整理只按明显文件类型归类；项目目录会保持原有结构。第一版不会删除文件。</p>
    </Panel>
    {error && <Panel title="无法继续"><p className="error-text">{error}</p></Panel>}
    {message && <Panel title="整理状态"><p>{message}</p></Panel>}
    {plan === null ? <EmptyState icon="⌘" title="还没有整理计划" detail="选择一个文件夹后，先查看建议和预览，再决定是否执行。" /> : <>
      <Panel title="扫描结果" subtitle={plan.scan.truncated ? '目录较大，当前计划只包含扫描预算内的内容。' : '计划已经生成，当前文件尚未被移动。'}><div className="metric-grid"><div className="metric"><span>文件</span><strong>{plan.scan.file_count ?? 0}</strong></div><div className="metric"><span>文件夹</span><strong>{plan.scan.directory_count ?? 0}</strong></div><div className="metric"><span>总大小</span><strong>{formatBytes(plan.scan.total_bytes ?? 0)}</strong></div><div className="metric"><span>完全相同文件组</span><strong>{plan.scan.duplicates?.length ?? 0}</strong><small>仅提示，不会删除</small></div></div>{(plan.scan.project_roots?.length ?? 0) > 0 && <p>已保持项目目录原结构：{plan.scan.project_roots?.join('、')}</p>}</Panel>
      <Panel title="整理预览" subtitle={`将创建 ${directories} 个文件夹，移动 ${pending} 个文件，删除 0 个文件。`}><div className="organizer-preview"><strong>{asset?.asset.display_name ?? '所选文件夹'}/</strong><ul>{plan.operations.filter(item => item.type === 'mkdir').map(item => <li key={item.id}>📁 {item.destination_relative_path}/</li>)}</ul></div><div className="organizer-operation-list">{plan.operations.filter(item => item.type !== 'mkdir').map(item => <label key={item.id} className={item.status === 'failed' ? 'failed' : ''}><input type="checkbox" checked={selected.has(item.id)} disabled={busy || item.status !== 'pending'} onChange={() => toggle(item.id)} /><span><strong>{operationLabel(item)}</strong><small>为什么这样整理：{item.reason}</small>{item.error && <em>{friendly(item.error)}</em>}</span>{['draft','reviewed'].includes(plan.status) && <button type="button" disabled={busy} onClick={() => void editDestination(item)}>修改目录</button>}</label>)}</div>{['draft','reviewed','approved'].includes(plan.status) && <button type="button" className="primary" disabled={busy || selected.size === 0} onClick={() => void execute()}>{busy ? '正在执行…' : '执行整理'}</button>}{['completed','completed_with_errors'].includes(plan.status) && <button type="button" onClick={() => void undo()} disabled={busy}>撤销整理</button>}{plan.status === 'undone' && <Badge tone="blue">已撤销</Badge>}</Panel>
      {(plan.scan.needs_confirmation?.length ?? 0) > 0 && <Panel title="需要你确认" subtitle="这些文件信息不足，默认保持原位；你可以选择后指定所选文件夹内的目标目录。"><div className="organizer-operation-list">{plan.scan.needs_confirmation?.map(item => <label key={item.source_relative_path}><input type="checkbox" checked={pendingSelection.has(item.source_relative_path)} disabled={busy || !['draft','reviewed'].includes(plan.status)} onChange={() => setPendingSelection(current => { const next=new Set(current); if(next.has(item.source_relative_path))next.delete(item.source_relative_path);else next.add(item.source_relative_path);return next })} /><span><strong>{item.source_relative_path}</strong><small>当前建议：保持原位。{item.reason}</small></span></label>)}</div><div className="organizer-options"><label>移动到相对目录<input value={pendingDestination} placeholder="例如 课程资料/机械原理" onChange={event => setPendingDestination(event.target.value)} /></label><button type="button" disabled={busy || pendingSelection.size===0 || pendingDestination.trim().length===0 || !['draft','reviewed'].includes(plan.status)} onClick={() => void applyPendingDestination()}>应用到已选项目</button></div></Panel>}
    </>}
    {history.length > 0 && <Panel title="整理历史" subtitle="关闭应用后，已经完成的整理仍会保留记录；撤销时需要重新授权原文件夹。"><div className="organizer-operation-list">{history.slice(0, 8).map(item => <button type="button" key={item.id} onClick={() => { setPlan(item); setMessage('已打开历史整理计划。') }}><strong>{item.root_path.split(/[\\/]/u).filter(Boolean).pop() ?? '文件夹'}</strong><small>{item.mode === 'smart' ? '智能整理' : item.mode === 'project' ? '项目整理' : '轻度整理'} · {item.status === 'undone' ? '已撤销' : item.status === 'completed' ? '已完成' : item.status}</small></button>)}</div></Panel>}
    <Panel title="我的整理规则" subtitle="例如把 PDF 课程资料优先放入你指定的目录；规则只影响建议，执行前仍需要确认。"><div className="organizer-options"><label>匹配文件<input value={rulePattern} placeholder="例如 *.pdf" onChange={event => setRulePattern(event.target.value)} /></label><label>建议目录<input value={ruleDestination} placeholder="例如 课程资料/高数" onChange={event => setRuleDestination(event.target.value)} /></label><button type="button" disabled={busy} onClick={() => void createRule()}>保存规则</button></div>{rules.length > 0 && <p className="subtle">已启用：{rules.slice(0, 5).map(rule => `${rule.pattern} → ${rule.destination_relative_path}`).join('；')}</p>}</Panel>
  </div>
}
