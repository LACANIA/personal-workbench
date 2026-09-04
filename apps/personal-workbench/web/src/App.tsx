import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DatabaseRole, TaskTemplate, WorkbenchTask } from '../../shared/contracts/index.ts'
import { api } from './api/client.ts'
import type { AppSnapshot, PageId } from './app/types.ts'
import { TaskDetail } from './components/TaskDetail.tsx'
import { StatusDot } from './components/common.tsx'
import { FirstRunWizard } from './components/FirstRunWizard.tsx'
import { MemoryPage } from './pages/MemoryPage.tsx'
import { ProjectsPage } from './pages/ProjectsPage.tsx'
import { ReviewQueuePage } from './pages/ReviewQueuePage.tsx'
import { ReviewHistoryPage } from './pages/ReviewHistoryPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'
import { TasksPage } from './pages/TasksPage.tsx'
import { VideoPage } from './pages/VideoPage.tsx'
import { WorkbenchPage } from './pages/WorkbenchPage.tsx'
import { FileOrganizerPage } from './pages/FileOrganizerPage.tsx'

const NAVIGATION: { id: PageId; label: string; icon: string }[] = [
  { id: 'workbench', label: '工作台', icon: '⌂' },
  { id: 'organizer', label: '整理文件', icon: '⌘' },
  { id: 'projects', label: '项目', icon: '◇' },
  { id: 'reviews', label: '审核队列', icon: '✓' },
  { id: 'review-history', label: '审核历史', icon: '↻' },
  { id: 'tasks', label: '任务与历史', icon: '◷' },
  { id: 'memory', label: '记忆与证据', icon: '⌁' },
  { id: 'video', label: '知识导入', icon: '▶' },
  { id: 'settings', label: '设置', icon: '⚙' },
]

const EMPTY_SNAPSHOT: AppSnapshot = {
  health: null, capabilities: null, models: null, profiles: [],
  workspaces: { allowedRoots: [], recent: [] }, projects: [], projectContexts: [], memory: null, documentSearch: null, legacy: null, localConfig: null, distribution: null,
}

export default function App(): JSX.Element {
  const [page, setPage] = useState<PageId>('workbench')
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT)
  const [tasks, setTasks] = useState<WorkbenchTask[]>([])
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const [developerMode, setDeveloperMode] = useState(false)
  const [advancedMode, setAdvancedMode] = useState(false)
  const interfaceModeLoaded = useRef(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const databaseRole: DatabaseRole = developerMode ? 'test' : 'production'

  const load = useCallback(async () => {
    try {
      const [health, capabilities, models, profiles, workspaces, projects, projectContexts, memory, documentSearch, legacy, localConfig, distribution, taskRows] = await Promise.all([
        api.health(), api.capabilities(), api.models(), api.profiles(), api.workspaces(), api.projects(databaseRole),
        api.projectContexts(), api.memoryStatus(databaseRole), api.documentStatus(databaseRole), api.legacy(), api.localConfig(), api.distribution(), api.tasks({ limit: advancedMode ? 500 : 30, include_internal: advancedMode, include_hidden: advancedMode }),
      ])
      setSnapshot({ health, capabilities, models, profiles, workspaces, projects: projects.projects, projectContexts, memory, documentSearch, legacy, localConfig, distribution })
      if (!interfaceModeLoaded.current) {
        interfaceModeLoaded.current = true
        setAdvancedMode(localConfig.interface_mode === 'advanced')
      }
      setTemplates(capabilities.templates)
      setTasks(taskRows)
      setLoadError('')
    } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }, [databaseRole, advancedMode])

  useEffect(() => { void load() }, [load])
  useEffect(() => window.personalWorkbenchDesktop?.onNavigate(value => {
    if (NAVIGATION.some(item => item.id === value)) setPage(value as PageId)
  }), [])
  useEffect(() => {
    const timer = setInterval(() => { void api.tasks({ limit: advancedMode ? 500 : 30, include_internal: advancedMode, include_hidden: advancedMode }).then(setTasks).catch(() => undefined) }, 1800)
    return () => clearInterval(timer)
  }, [advancedMode])

  const changeInterfaceMode = useCallback((value: boolean) => {
    setAdvancedMode(value)
    void api.updateInterfaceMode(value ? 'advanced' : 'consumer').catch(error => setLoadError(`界面模式没有保存：${error instanceof Error ? error.message : String(error)}`))
  }, [])

  const healthStatus = String(snapshot.health?.status ?? (loadError ? 'error' : 'loading'))
  const pageTitle = NAVIGATION.find(item => item.id === page)?.label ?? '工作台'
  const content = useMemo(() => {
    if (page === 'workbench') return <WorkbenchPage snapshot={snapshot} templates={templates} tasks={tasks} databaseRole={databaseRole} advancedMode={advancedMode} onTaskCreated={task => setTasks(rows => [task, ...rows])} onOpenTask={setSelectedTask} />
    if (page === 'organizer') return <FileOrganizerPage />
    if (page === 'projects') return <ProjectsPage snapshot={snapshot} databaseRole={databaseRole} onOpenTask={setSelectedTask} onRefresh={load} />
    if (page === 'reviews') return <ReviewQueuePage snapshot={snapshot} />
    if (page === 'review-history') return <ReviewHistoryPage snapshot={snapshot} />
    if (page === 'tasks') return <TasksPage tasks={tasks} modelName={snapshot.localConfig?.model_name ?? '本机模型'} advancedMode={advancedMode} onOpenTask={setSelectedTask} />
    if (page === 'memory') return <MemoryPage snapshot={snapshot} databaseRole={databaseRole} />
    if (page === 'video') return <VideoPage snapshot={snapshot} developerMode={developerMode} advancedMode={advancedMode} />
    return <SettingsPage snapshot={snapshot} developerMode={developerMode} advancedMode={advancedMode} onDeveloperMode={setDeveloperMode} onAdvancedMode={changeInterfaceMode} />
  }, [page, snapshot, templates, tasks, databaseRole, developerMode, advancedMode, load, changeInterfaceMode])

  if (!api.hasToken) return <main className="access-screen"><div><span className="brand-mark">PW</span><h1>需要本机会话令牌</h1><p>请使用“一键启动”入口打开工作台。令牌仅在本次服务周期内有效。</p></div></main>
  if (loading) return <main className="loading-screen"><span className="brand-mark">PW</span><div className="loading-bar"><i /></div><p>正在检查本机组件…</p></main>

  return <div className="app-shell">
    {snapshot.distribution?.first_run && <FirstRunWizard status={snapshot.distribution.first_run} />}
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">PW</span><div><strong>Personal</strong><small>Workbench</small></div></div>
      <nav>{NAVIGATION.map(item => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}><span>{item.icon}</span>{item.label}{item.id === 'video' && <i>local</i>}</button>)}</nav>
      <div className="sidebar-foot"><div className="local-state"><StatusDot status={healthStatus === 'ok' ? 'ok' : healthStatus === 'degraded' ? 'warning' : 'error'} /><span><strong>本机服务</strong><small>{healthStatus === 'ok' ? '主要组件可用' : '需要检查'}</small></span></div><button onClick={() => setPage('settings')}>运行诊断</button></div>
    </aside>
    <main className="main-shell">
      <header className="topbar"><div><span>Personal Workbench</span><b>/</b><strong>{pageTitle}</strong></div><div className="top-actions">{developerMode && <span className="dev-pill">开发模式 · 测试数据</span>}<button title="刷新" onClick={() => void load()}>↻</button><span className="avatar">本机</span></div></header>
      {loadError && <div className="global-error"><strong>部分状态读取失败</strong><span>{loadError}</span><button onClick={() => void load()}>重试</button></div>}
      <div className="page-content">{content}</div>
    </main>
    {selectedTask && <div className="task-overlay"><div className="task-overlay-backdrop" onClick={() => setSelectedTask(null)} /><div className="task-overlay-panel"><TaskDetail taskId={selectedTask} advancedMode={advancedMode} onClose={() => setSelectedTask(null)} onOpenTask={setSelectedTask} /></div></div>}
  </div>
}
