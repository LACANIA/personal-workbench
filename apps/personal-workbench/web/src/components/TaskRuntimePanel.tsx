import { useEffect, useMemo, useState } from 'react'
import type { TaskEvent, TaskRuntimeStage, TaskRuntimeView } from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import { Badge, EmptyState, formatDuration } from './common.tsx'

const STAGES: Array<[TaskRuntimeStage, string]> = [
  ['created', '创建任务'], ['initializing', '初始化'], ['detecting_source', '来源检测'], ['adapting', '文件授权与适配'], ['fetching', '下载或读取输入'], ['processing', '内容处理'],
  ['transcribing', 'ASR 转写'], ['segmenting', '时间轴分段'], ['embedding', '检索索引'], ['extracting', '知识提取'],
  ['generating', '报告与产物'], ['learning_document_planning', '整理学习资料'], ['learning_document_generating', '组织章节与问题'], ['docx_rendering', '生成 Word 文档'], ['output_ready', '学习资料已完成'],
  ['scanning_files', '扫描文件'], ['analyzing_files', '分析文件类型'], ['planning_organization', '生成整理方案'], ['awaiting_confirmation', '等待确认'], ['creating_directories', '创建目录'], ['moving_files', '移动文件'], ['review', '人工审核'], ['completed', '已完成'], ['failed', '失败'],
]

function eventLog(event: TaskEvent): TaskRuntimeView['logs'][number] | null {
  if (event.eventType !== 'runtime.log' || event.payload === null || typeof event.payload !== 'object') return null
  const value = event.payload as Record<string, unknown>
  if (typeof value.stage !== 'string' || typeof value.message !== 'string') return null
  return {
    timestamp: typeof value.timestamp === 'string' ? value.timestamp : event.createdAt,
    stage: value.stage as TaskRuntimeStage,
    level: value.level === 'warning' || value.level === 'error' ? value.level : 'info',
    message: value.message,
  }
}

function terminal(status: string): boolean { return ['completed', 'failed', 'canceled'].includes(status) }

function isRuntimeView(value: unknown): value is TaskRuntimeView {
  if (value === null || typeof value !== 'object') return false
  const runtime = (value as Record<string, unknown>).runtime
  return runtime !== null && typeof runtime === 'object'
    && typeof (runtime as Record<string, unknown>).task_id === 'string'
    && typeof (runtime as Record<string, unknown>).current_stage === 'string'
    && Array.isArray((value as Record<string, unknown>).logs)
}

export function TaskRuntimePanel({ taskId, title, compact = false }: { taskId: string; title?: string; compact?: boolean }): JSX.Element {
  const [view, setView] = useState<TaskRuntimeView | null>(null)
  const [streamState, setStreamState] = useState<'connecting' | 'live' | 'fallback'>('connecting')
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    const refresh = async () => {
      try {
        const next = await api.taskRuntime(taskId)
        if (!disposed && isRuntimeView(next)) setView(next)
        else if (!disposed) setError('任务运行状态格式无效。')
      } catch (caught) { if (!disposed) setError(caught instanceof Error ? caught.message : String(caught)) }
    }
    void refresh()
    const stop = api.streamTaskEvents(taskId, event => {
      if (disposed) return
      setStreamState('live')
      const log = eventLog(event)
      if (log !== null) setView(current => current === null ? current : { ...current, logs: [...current.logs, log].slice(-200) })
      if (event.eventType === 'runtime.state' || event.eventType === 'runtime.stage' || event.eventType.startsWith('task.')) void refresh()
    }, () => { if (!disposed) setStreamState('fallback') })
    const timer = setInterval(() => { setNow(Date.now()); if (!terminal(view?.runtime.status ?? 'running')) void refresh() }, 1200)
    return () => { disposed = true; stop(); clearInterval(timer) }
  }, [taskId, view?.runtime.status])

  const stageIndex = useMemo(() => STAGES.findIndex(([stage]) => stage === view?.runtime.current_stage), [view?.runtime.current_stage])
  if (view === null) return <section className={`task-runtime-panel ${compact ? 'compact' : ''}`}><EmptyState icon="◌" title="正在连接任务运行状态" detail={error || '正在读取本机任务事件。'} /></section>
  const { runtime } = view
  const elapsedEnd = runtime.finished_at ?? new Date(now).toISOString()
  return <section className={`task-runtime-panel ${compact ? 'compact' : ''}`} aria-label="任务运行面板">
    <header>
      <div><span>Task Runtime</span><strong>{title ?? runtime.task_type}</strong>{!compact && <small>{runtime.task_id}</small>}</div>
      <div className="runtime-status"><Badge tone={runtime.status === 'completed' ? 'green' : runtime.status === 'failed' || runtime.status === 'canceled' ? 'red' : 'blue'}>{runtime.status}</Badge><small>{streamState === 'live' ? '实时事件' : streamState === 'fallback' ? '轮询回退' : '连接中'}</small></div>
    </header>
    <div className="runtime-progress"><div><span>当前步骤：{STAGES.find(([stage]) => stage === runtime.current_stage)?.[1] ?? runtime.current_stage}</span><strong>{runtime.progress}%</strong></div><i><b style={{ width: `${runtime.progress}%` }} /></i><p>{runtime.message}</p></div>
    {!compact && <div className="runtime-stages">{STAGES.map(([stage, label], index) => <div key={stage} className={view.completed_stages.includes(stage) || (stageIndex >= 0 && index < stageIndex) ? 'done' : stage === runtime.current_stage ? 'active' : ''}><i>{view.completed_stages.includes(stage) || (stageIndex >= 0 && index < stageIndex) ? '✓' : index + 1}</i><span>{label}</span></div>)}</div>}
    <div className="runtime-meta"><span>运行时间 <b>{formatDuration(runtime.started_at, elapsedEnd)}</b></span><span>模型 <b>{runtime.active_model ?? '当前阶段不需要模型'}</b></span><span>当前工具 <b>{view.active_tool ?? '正在等待工具事件'}</b></span><span>完成步骤 <b>{view.completed_stages.length}</b></span></div>
    {!compact && <div className="runtime-log"><h3>实时日志</h3>{view.logs.length === 0 ? <p>当前还没有可展示的运行日志。</p> : view.logs.slice(-12).reverse().map((log, index) => <article key={`${log.timestamp}-${index}`}><time>{new Date(log.timestamp).toLocaleTimeString('zh-CN')}</time><Badge tone={log.level === 'error' ? 'red' : log.level === 'warning' ? 'amber' : 'blue'}>{log.stage}</Badge><span>{log.message}</span></article>)}</div>}
  </section>
}
