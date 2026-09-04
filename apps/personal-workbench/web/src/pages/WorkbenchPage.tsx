import { useEffect, useMemo, useState } from 'react'
import type { DatabaseRole, InputAssetView, ProjectEvidenceHealth, TaskTemplate, TemplateId, WorkbenchTask } from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import type { AppSnapshot } from '../app/types.ts'
import { Badge, EmptyState, formatBytes, Panel, StatusDot } from '../components/common.tsx'
import { orderedTemplates, recognizeInput } from '../features/input-recognition.ts'

function sourceLabel(input: InputAssetView): string {
  if (input.asset.source_mode === 'native_picker') return '系统文件选择器'
  if (input.asset.source_mode === 'drag_drop') return '拖放导入'
  if (input.asset.source_mode === 'project') return 'Project Context'
  return input.asset.source_mode
}

function accessLabel(input: InputAssetView): string {
  if (input.asset.access_mode === 'temporary_grant') return input.grant?.scope === 'exact_file' ? '仅当前任务可读取此文件' : '仅当前任务可读取所选目录树'
  if (input.asset.access_mode === 'staged_copy') return 'Personal Inbox 分析副本'
  return '已登记项目范围'
}

function sourceLabelForTask(task: WorkbenchTask): string {
  if (task.inputType === 'github_repo' || task.inputValue.includes('github.com/')) return 'GitHub'
  if (task.inputType === 'web_url' || /^https?:\/\//iu.test(task.inputValue)) return '网页'
  if (task.inputType === 'url' || task.inputType === 'video_url') return '视频'
  if (task.inputType === 'directory' || task.inputType === 'local_folder') return '文件夹'
  if (task.inputType === 'file' || task.inputType === 'local_file') return '文件'
  return '文本'
}

function sourceIconForTask(task: WorkbenchTask): string {
  const label = sourceLabelForTask(task)
  return label === '文件' ? '▤' : label === '文件夹' ? '▱' : label === '视频' ? '▶' : label === '网页' ? '◎' : label === 'GitHub' ? '⌘' : '✎'
}

function resultLabelForTask(task: WorkbenchTask): string {
  if (task.status === 'completed' && (task.inputType === 'github_repo' || task.inputType === 'web_url' || task.metadata.documentMode !== undefined || task.metadata.execution === 'video-local-v1')) return '学习资料已生成'
  if (task.status === 'failed') return '处理失败'
  return task.status === 'completed' ? '已完成' : '处理中'
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('PATH_POLICY_DENIED')) return '此路径尚未获得访问许可。请通过系统窗口重新选择。'
  if (message.includes('SOURCE_URL_PRIVATE_NETWORK_DENIED') || message.includes('SOURCE_URL_LOCALHOST_DENIED')) return '为了保护本机数据，不能从链接访问本机或私有网络地址。'
  if (message.includes('SOURCE_URL_SCHEME_DENIED') || message.includes('SOURCE_URL_CREDENTIALS_DENIED')) return '此链接格式不受支持，请使用不含账号信息的公开 HTTP 或 HTTPS 地址。'
  if (message.includes('CONTENT_TOO_SHORT')) return '页面可以访问，但没有提取到足够正文。'
  if (message.includes('DYNAMIC_PAGE_UNSUPPORTED')) return '该页面需要浏览器动态加载，当前版本暂时无法直接读取。你可以保存网页、复制正文后导入。'
  if (message.includes('DOCUMENT_PDF_PENDING')) return '这是 PDF 资料，PDF 解析将在文档适配器中处理。'
  if (message.includes('INPUT_PICKER_FAILED') || message.includes('INPUT_PICKER_TIMEOUT')) return '系统选择窗口未能完成操作，请稍后重试。'
  if (message.includes('INPUT_PARSER_REQUIRED')) return '当前文件已经登记，但需要相应解析组件，暂时无法启动内容分析。'
  if (message.includes('INPUT_PICKER_USER_ACTION_REQUIRED')) return '需要由用户点击选择按钮后打开系统窗口。'
  return message
}

export function WorkbenchPage({ snapshot, templates, tasks, databaseRole, advancedMode = false, onTaskCreated, onOpenTask }: {
  snapshot: AppSnapshot
  templates: TaskTemplate[]
  tasks: WorkbenchTask[]
  databaseRole: DatabaseRole
  advancedMode?: boolean
  onTaskCreated(task: WorkbenchTask): void
  onOpenTask(id: string): void
}): JSX.Element {
  const [input, setInput] = useState('')
  const [inputAsset, setInputAsset] = useState<InputAssetView | null>(null)
  const [selected, setSelected] = useState<TemplateId>('file-analysis')
  const [project, setProject] = useState('')
  const [folderIntent, setFolderIntent] = useState<'analyze' | 'project'>('analyze')
  const [dragActive, setDragActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [projectHealth, setProjectHealth] = useState<ProjectEvidenceHealth | null>(null)
  const [projectHealthError, setProjectHealthError] = useState('')
  const recognition = useMemo(() => inputAsset === null
    ? recognizeInput(input)
    : { type: inputAsset.asset.input_type, recommended: inputAsset.asset.input_type === 'directory' ? ['asset-inventory' as const] : ['file-analysis' as const], label: inputAsset.capability.category }, [input, inputAsset])
  const ordered = useMemo(() => orderedTemplates(input, templates), [input, templates])

  useEffect(() => {
    const projectId = snapshot.projectContexts[0]?.id
    if (projectId === undefined) { setProjectHealth(null); setProjectHealthError(''); return }
    let active = true
    void api.projectEvidenceHealth(projectId).then(result => {
      if (active && typeof result.coverage === 'number') { setProjectHealth(result); setProjectHealthError('') }
    }).catch(caught => {
      if (active) { setProjectHealth(null); setProjectHealthError(caught instanceof Error ? caught.message : String(caught)) }
    })
    return () => { active = false }
  }, [snapshot.projectContexts])

  const useAsset = (value: InputAssetView) => {
    setInputAsset(value)
    setInput(value.effective_path ?? value.asset.display_name)
    setFolderIntent('analyze')
    setSelected(value.asset.input_type === 'directory' ? 'asset-inventory' : 'file-analysis')
    setError('')
    setNotice(value.asset.access_mode === 'staged_copy' ? '已导入分析副本，原始文件未修改。' : '已建立范围最小的本次任务授权。')
  }

  const choose = async (kind: 'file' | 'directory') => {
    setBusy(true); setError(''); setNotice('正在打开 Windows 系统选择窗口，请查看前台窗口或任务栏。')
    try {
      const result = kind === 'file' ? await api.selectFile() : await api.selectDirectory()
      if (result.canceled) { setNotice('已经取消选择。'); return }
      if (result.asset !== null) useAsset(result.asset)
    } catch (caught) { setError(friendlyError(caught)) }
    finally { setBusy(false) }
  }

  const stage = async (file: File) => {
    setBusy(true); setError(''); setNotice('')
    try { useAsset(await api.stageInput(file)) }
    catch (caught) { setError(friendlyError(caught)) }
    finally { setBusy(false); setDragActive(false) }
  }

  const clearAsset = async () => {
    if (inputAsset === null) return
    try { await api.deleteInputAsset(inputAsset.asset.id) } catch { /* attached inputs remain auditable */ }
    setInputAsset(null); setInput(''); setNotice(''); setError('')
  }

  const registerFolder = async () => {
    if (inputAsset?.asset.input_type !== 'directory' || inputAsset.effective_path === null) return
    setBusy(true); setError(''); setNotice('')
    try {
      const registered = await api.registerProject({ rootPath: inputAsset.effective_path, inputAssetId: inputAsset.asset.id })
      setFolderIntent('project')
      setNotice(`已显式登记 Project Context：${registered.name}。文件夹分析不会自动执行。`)
      setInputAsset(await api.inputAsset(inputAsset.asset.id))
    } catch (caught) { setError(friendlyError(caught)) }
    finally { setBusy(false) }
  }

  const start = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      if (inputAsset?.asset.input_type === 'directory' && folderIntent === 'project') throw new Error('该文件夹已经登记为项目，请在项目页面创建项目任务。')
      if (inputAsset === null && recognition.type === 'url') {
        const ingestion = await api.ingestKnowledge({ input_value: input })
        onTaskCreated(ingestion.task); onOpenTask(ingestion.task.id)
        return
      }
      const task = await api.createTask({
        templateId: selected, inputType: recognition.type, inputValue: input,
        ...(inputAsset === null ? {} : { inputAssetId: inputAsset.asset.id }),
        ...(project.trim() ? { projectName: project.trim() } : {}), databaseRole,
      })
      await api.startTask(task.id)
      onTaskCreated(task); onOpenTask(task.id)
    } catch (caught) { setError(friendlyError(caught)) }
    finally { setBusy(false) }
  }

  const checks = (snapshot.health?.checks ?? []) as { id: string; label: string; status: string; summary: string }[]
  const healthy = checks.filter(item => item.status === 'ok').length
  return <div className="page-stack">
    <section className="hero"><div className="hero-copy"><Badge tone="green">本机运行</Badge><h1>从资料输入开始，完成可追溯的本地任务</h1><p>可以选择文件、选择文件夹、拖入副本，或者输入问题和网址；系统会展示访问范围与处理能力。</p></div><div className="health-summary"><span className="health-orbit">{healthy}<small>项正常</small></span><div><strong>本地服务状态</strong><p>{snapshot.health?.status === 'ok' ? '主要组件可以使用' : '部分组件需要检查'}</p></div></div></section>

    <Panel title="开始一个任务" subtitle="把文件、文件夹、网址或问题交给我，系统会自动判断处理方式。" className="composer-panel">
      <div className="universal-input-actions"><button type="button" disabled={busy} onClick={() => void choose('file')}>选择文件</button><button type="button" disabled={busy} onClick={() => void choose('directory')}>选择文件夹</button><span>也可以粘贴路径、网址或自然语言问题</span></div>
      <div className={`input-drop-zone ${dragActive ? 'active' : ''}`} onDragEnter={event => { event.preventDefault(); setDragActive(true) }} onDragOver={event => { event.preventDefault(); setDragActive(true) }} onDragLeave={event => { event.preventDefault(); setDragActive(false) }} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files.item(0); if (file !== null) void stage(file); else setDragActive(false) }}><strong>拖入文件开始分析</strong><span>浏览器拖放会创建 Personal Inbox 分析副本，原始文件不会被修改。</span><label className="staged-copy-picker">选择并导入分析副本<input aria-label="选择并导入分析副本" type="file" disabled={busy} onChange={event => { const file = event.currentTarget.files?.item(0) ?? null; event.currentTarget.value = ''; if (file !== null) void stage(file) }} /></label></div>
      <div className="composer"><textarea value={input} onChange={event => { setInput(event.target.value); setInputAsset(null); const first = orderedTemplates(event.target.value, templates)[0]; if (first) setSelected(first.id) }} placeholder="输入问题、粘贴路径或粘贴网址…" /><div className="composer-tools"><div className="input-actions"><button type="button" onClick={() => { setInput('STAKG-SP 中 0.0136% 对应哪些记录？'); setInputAsset(null) }}>项目问题</button></div><div className="detected"><span>识别为</span><Badge tone="blue">{recognition.label}</Badge></div></div></div>
      {inputAsset && <section className="input-asset-card"><div><Badge tone={inputAsset.capability.analyzable ? 'green' : 'amber'}>{inputAsset.capability.label}</Badge><strong>{inputAsset.asset.display_name}</strong><small>{inputAsset.asset.size_bytes === null ? inputAsset.asset.input_type : formatBytes(inputAsset.asset.size_bytes)} · {sourceLabel(inputAsset)}</small></div><dl><div><dt>访问方式</dt><dd>{accessLabel(inputAsset)}</dd></div><div><dt>Project Context</dt><dd>{inputAsset.asset.project_id ? '已登记项目' : 'Personal Inbox'}</dd></div><div><dt>报告位置</dt><dd>Personal Inbox/output</dd></div></dl><button type="button" onClick={() => void clearAsset()}>移除输入</button></section>}
      {inputAsset?.asset.input_type === 'directory' && <section className="folder-intent"><strong>如何使用此文件夹？</strong><div><button className={folderIntent === 'analyze' ? 'selected' : ''} onClick={() => { setFolderIntent('analyze'); setSelected('asset-inventory') }}>分析此文件夹（默认）</button><button className={folderIntent === 'project' ? 'selected' : ''} onClick={() => void registerFolder()}>登记为项目</button></div><p>分析模式使用 Personal Inbox 与当前目录授权，不会创建 Project Context。</p></section>}
      <div className="template-row">{ordered.slice(0, 4).map(template => <button key={template.id} className={`template-choice ${selected === template.id ? 'selected' : ''}`} onClick={() => setSelected(template.id)}><span>{template.label}</span><small>{template.description}</small></button>)}</div>
      {(selected === 'memory-query' || selected === 'project-summary' || selected === 'document-chunk-search') && <label className="inline-field"><span>项目限定</span><input value={project} onChange={event => setProject(event.target.value)} placeholder="可选，例如 STAKG-SP" /></label>}
      <div className="composer-footer"><div>{notice && <span className="success-text">{notice}</span>}{error && <span className="error-text">{error}</span>}{advancedMode && <small>当前模式：{databaseRole === 'test' ? '测试数据' : '正式数据'} · read-only</small>}</div><button className="primary" disabled={busy || input.trim().length === 0 || inputAsset?.capability.analyzable === false || folderIntent === 'project'} onClick={() => void start()}>{busy ? '正在处理…' : '开始任务'} <span>→</span></button></div>
    </Panel>

    <div className="dashboard-grid">
      {advancedMode && <><Panel title="本机组件" subtitle={`${healthy}/${checks.length || 0} 项可用`}><div className="check-list">{checks.slice(0, 8).map(check => <div key={check.id}><StatusDot status={check.status} /><span><strong>{check.label}</strong><small>{check.summary}</small></span></div>)}</div></Panel><Panel title="Project Health" subtitle={projectHealth?.project_name ?? snapshot.projectContexts[0]?.name ?? '尚无项目'}>{snapshot.projectContexts.length === 0 ? <EmptyState icon="◇" title="尚无 Project Context" detail="登记项目后会显示 Evidence Coverage。" /> : projectHealth === null ? <p className="muted">{projectHealthError || '正在计算 Evidence 状态…'}</p> : <div className="project-health-card"><div><strong>{(projectHealth.coverage * 100).toFixed(1)}%</strong><span>Evidence Coverage</span></div><div><strong>{projectHealth.artifact_count}</strong><span>Artifacts</span></div><div><strong>{projectHealth.issue_count}</strong><span>Issues</span></div></div>}</Panel></>}
      <Panel title="最近任务" subtitle="打开结果或查看处理过程">{tasks.length === 0 ? <EmptyState icon="◷" title="还没有任务" detail="把一个文件或链接交给我。" /> : <div className="recent-list">{tasks.slice(0, 5).map(task => <button key={task.id} onClick={() => onOpenTask(task.id)}><span><i aria-hidden="true">{sourceIconForTask(task)}</i><strong>{task.title}</strong><small>{sourceLabelForTask(task)} · {new Date(task.createdAt).toLocaleString('zh-CN')}</small><small>{resultLabelForTask(task)}</small></span><Badge tone={task.status === 'completed' ? 'green' : task.status === 'failed' ? 'red' : 'blue'}>{task.status === 'completed' ? '已完成' : task.status === 'failed' ? '处理失败' : '处理中'}</Badge></button>)}</div>}</Panel>
    </div>
  </div>
}
