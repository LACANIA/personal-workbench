import { useEffect, useMemo, useState } from 'react'
import type { WorkbenchTask } from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import { Badge, EmptyState, formatDuration, Panel } from '../components/common.tsx'

const sourceLabel = (t: WorkbenchTask) => t.inputType === 'github_repo' || t.inputValue.includes('github.com/') ? 'GitHub' : t.inputType === 'video_url' ? '视频' : t.inputType === 'web_url' || /^https?:\/\//iu.test(t.inputValue) ? '网页' : t.inputType === 'directory' || t.inputType === 'local_folder' ? '文件夹' : t.inputType === 'file' || t.inputType === 'local_file' ? '文件' : '文本'
const running = (s: string) => ['queued', 'starting', 'running', 'validating', 'created'].includes(s)
const statusLabel = (s: string) => s === 'completed' ? '已完成' : s === 'failed' ? '处理失败' : running(s) ? '处理中' : s

export function TasksPage({ tasks, modelName = '本机模型', advancedMode = false, onOpenTask }: { tasks: WorkbenchTask[]; modelName?: string; advancedMode?: boolean; onOpenTask(id: string): void }): JSX.Element {
  const [filter, setFilter] = useState<'all' | 'running' | 'completed' | 'failed'>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rows, setRows] = useState(tasks)
  useEffect(() => setRows(tasks), [tasks])
  const visible = useMemo(() => rows.filter(task => { const pass = filter === 'all' || (filter === 'running' ? running(task.status) : task.status === filter); const q = search.trim().toLocaleLowerCase(); return pass && (!q || `${task.title} ${task.inputValue}`.toLocaleLowerCase().includes(q)) }), [rows, filter, search])
  const hide = async (ids: string[]) => { await Promise.all(ids.map(id => api.hideTask(id))); setRows(value => value.filter(task => !ids.includes(task.id))); setSelected(new Set()) }
  return <div className="page-stack">
    <header className="page-heading"><div><Badge tone="blue">任务与历史</Badge><h1>任务中心</h1><p>查看最近任务、运行状态和已经生成的学习资料。</p></div></header>
    <Panel title="任务记录" subtitle={`${visible.length} 条记录`}>
      <div className="task-filters"><div>{(['all', 'running', 'completed', 'failed'] as const).map(item => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item === 'all' ? '全部' : item === 'running' ? '处理中' : item === 'completed' ? '已完成' : '失败'}</button>)}</div><input value={search} onChange={event => setSearch(event.target.value)} placeholder="按标题或来源搜索" /><button disabled={selected.size === 0} onClick={() => void hide([...selected])}>隐藏所选</button>{advancedMode && <button onClick={() => void hide(rows.filter(task => task.taskOrigin === 'validation' || task.taskOrigin === 'system').map(task => task.id))}>隐藏验收任务</button>}</div>
      {visible.length === 0 ? <EmptyState icon="◷" title="尚无任务记录" detail="还没有任务，把一个文件或链接交给我。" /> : <div className="task-table"><div className="task-row task-head"><span>任务</span><span>来源</span><span>状态</span><span>结果</span><span>耗时</span><span>操作</span></div>{visible.map(task => <div className="task-row" key={task.id}><input type="checkbox" checked={selected.has(task.id)} onChange={() => setSelected(value => { const next = new Set(value); next.has(task.id) ? next.delete(task.id) : next.add(task.id); return next })} /><button onClick={() => onOpenTask(task.id)}><span><strong>{task.title}</strong><small>{new Date(task.createdAt).toLocaleString('zh-CN')}</small></span><span>{sourceLabel(task)}</span><span><Badge tone={task.status === 'completed' ? 'green' : task.status === 'failed' ? 'red' : 'blue'}>{statusLabel(task.status)}</Badge></span><span>{task.status === 'completed' ? '打开结果' : task.status === 'failed' ? '查看原因' : '查看过程'}</span><span>{formatDuration(task.startedAt, task.completedAt)}</span></button><button className="link-button" onClick={() => void hide([task.id])}>隐藏</button>{advancedMode && <small>{task.taskOrigin ?? 'legacy'} · {String(task.metadata.model ?? (task.profile ? modelName : '无模型'))}</small>}</div>)}</div>}
    </Panel>
  </div>
}
