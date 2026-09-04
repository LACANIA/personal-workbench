import { useEffect, useMemo, useState } from 'react'
import type {
  InputAssetView,
  KnowledgeIngestionResult,
  KnowledgeIngestionRecord,
  KnowledgeSourceType,
  KnowledgeCardDetail,
  KnowledgeCardReviewDecision,
  KnowledgeExtractionDiagnostics,
  RetrievalDiagnostics,
  UnifiedDocumentRecord,
  VideoJobRecord,
  VideoJobView,
} from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import type { AppSnapshot } from '../app/types.ts'
import { Badge, Panel } from '../components/common.tsx'
import { KnowledgeCardsPanel } from '../components/KnowledgeCardsPanel.tsx'
import { LearningDocumentPanel } from '../components/LearningDocumentPanel.tsx'
import { TaskRuntimePanel } from '../components/TaskRuntimePanel.tsx'

const PIPELINE = [
  ['created', '创建'], ['inspecting', '检查'], ['acquiring', '获取'], ['probing', '探测'], ['transcribing', '转写'], ['segmenting', '切片'],
  ['embedding', '索引'], ['analyzing', '分析'], ['packaging', '产物'], ['awaiting_review', '审核'], ['published', '发布'],
] as const

function time(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

function inputPlaceholder(type: 'auto' | KnowledgeSourceType, root: string): string {
  if (type === 'auto') return '粘贴网页、GitHub、视频链接或一段文字，系统会自动识别来源'
  if (type === 'video_url') return 'https://www.bilibili.com/video/BV...'
  if (type === 'web_url') return 'https://example.com/article'
  if (type === 'github_repo') return 'https://github.com/owner/repository'
  if (type === 'text_input') return '粘贴一段需要登记或后续处理的文字…'
  if (type === 'local_folder') return `${root}\\project`
  return `${root}\\project\\document.md`
}

export function friendlyVideoMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('VIDEO_DOWNLOADER_UNAVAILABLE') || message.includes('VIDEO_URL_QUERY_DENIED')) return '当前电脑尚未配置可用的 yt-dlp，因此暂时不能处理视频网站地址。请在设置页面检查媒体组件。'
  if (message.includes('VIDEO_AUTH_REQUIRED')) return '该视频需要登录或额外权限，当前本地模式没有读取浏览器登录信息。'
  if (message.includes('VIDEO_METADATA_PROBE_FAILED') && message.includes('412')) return '视频网站暂时拒绝了媒体信息读取。工作台不会读取浏览器 Cookie；请稍后重试，或改用本地视频、音频或字幕文件。'
  if (message.includes('FFMPEG_UNAVAILABLE') || message.includes('FFPROBE_UNAVAILABLE')) return '当前电脑缺少可用的 FFmpeg 媒体组件，请在“设置 → Media Runtime”重新检测。'
  if (message.includes('ASR_RUNTIME_MISSING') || message.includes('ASR_MODEL_MISSING') || message.includes('ASR_FAILED')) return '本机离线语音转写组件尚未就绪或执行失败，请在“设置 → Media Runtime”查看诊断。'
  if (message.includes('PATH_POLICY_DENIED')) return '此本机文件尚未获得访问许可，请使用“选择本机文件”重新选择。'
  if (message.includes('VIDEO_SUBTITLE_NOT_AVAILABLE')) return '当前电脑缺少可用字幕和本机 ASR 组件，暂时不能生成转录文本。'
  if (message.includes('CONTENT_TOO_SHORT')) return '页面可以访问，但没有提取到足够正文。'
  if (message.includes('DYNAMIC_PAGE_UNSUPPORTED')) return '该页面需要浏览器动态加载，当前版本暂时无法直接读取。你可以保存网页、复制正文或等待后续浏览器适配。'
  if (message.includes('DOCUMENT_PDF_PENDING')) return '这是 PDF 资料，PDF 解析将在文档适配器中处理。'
  if (message.includes('DOCUMENT_INPUT_AUTHORIZATION_REQUIRED')) return '请通过“选择文件”导入资料后再处理，系统不会直接读取手工输入的外部路径。'
  if (message.includes('PDF_TEXT_RUNTIME_MISSING')) return '当前电脑没有可用的 PDF 文字读取组件，暂时不能处理 PDF。'
  if (message.includes('PASSWORD_PROTECTED_DOCUMENT')) return '该文档受到密码保护，当前版本无法读取。'
  if (message.includes('MACRO_DOCUMENT_UNSUPPORTED')) return '当前版本暂不处理包含宏的 Word 文件。'
  if (message.includes('LEGACY_OFFICE_DOCUMENT_UNSUPPORTED')) return '这是旧版 Office 格式，请先另存为 DOCX、PPTX 或 XLSX 后导入。'
  if (message.includes('SOURCE_URL_PRIVATE_NETWORK_DENIED') || message.includes('SOURCE_URL_DENIED')) return '该链接不是可读取的公开 HTTP(S) 页面，工作台不会访问本机或私有网络地址。'
  if (message.includes('GIT_EXECUTABLE_MISSING')) return '当前电脑没有可用的 Git，暂时不能读取 GitHub 项目。'
  if (message.includes('GITHUB_CLONE_FAILED')) return '无法获取该公开 GitHub 项目，请检查网络、仓库地址或 Git 组件。'
  return message
}

export function VideoPage({ snapshot, developerMode, advancedMode = false }: { snapshot: AppSnapshot; developerMode: boolean; advancedMode?: boolean }): JSX.Element {
  const [sourceType, setSourceType] = useState<'auto' | KnowledgeSourceType>('auto')
  const [inputValue, setInputValue] = useState('')
  const [inputAsset, setInputAsset] = useState<InputAssetView | null>(null)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [jobs, setJobs] = useState<VideoJobRecord[]>([])
  const [ingestions, setIngestions] = useState<KnowledgeIngestionRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedIngestionTaskId, setSelectedIngestionTaskId] = useState<string | null>(null)
  const [selected, setSelected] = useState<VideoJobView | null>(null)
  const [activeIngestion, setActiveIngestion] = useState<KnowledgeIngestionResult | null>(null)
  const [selectedDocument, setSelectedDocument] = useState<UnifiedDocumentRecord | null>(null)
  const [documentQuestion, setDocumentQuestion] = useState('')
  const [documentAnswer, setDocumentAnswer] = useState<{ answer: string; citations: Array<{ title: string; section: string; source_anchor: string; text: string; score: number }> } | null>(null)
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'semantic' | 'local-hash-v1'>('semantic')
  const [searchEntityType, setSearchEntityType] = useState<'all' | 'video_segment' | 'knowledge_point' | 'knowledge_card'>('all')
  const [searchResults, setSearchResults] = useState<Awaited<ReturnType<typeof api.searchVideo>>>([])
  const [retrieval, setRetrieval] = useState<RetrievalDiagnostics | null>(null)
  const [knowledge, setKnowledge] = useState<KnowledgeExtractionDiagnostics | null>(null)
  const [knowledgeMode, setKnowledgeMode] = useState<'legacy' | 'structured'>('legacy')
  const [cardDetail, setCardDetail] = useState<KnowledgeCardDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const media = snapshot.distribution?.media
  const root = snapshot.workspaces.allowedRoots[0] ?? snapshot.localConfig?.workspace_root ?? ''

  const reloadJobs = async (): Promise<void> => {
    const [rows, sourceRows] = await Promise.all([api.videoJobs(projectId || undefined), api.knowledgeIngestions(projectId || undefined)])
    setJobs(advancedMode ? rows : rows.slice(0, 3))
    setIngestions(advancedMode ? sourceRows : sourceRows.slice(0, 5))
    if (selectedId !== null) setSelected(await api.videoJob(selectedId))
  }
  useEffect(() => { void reloadJobs().catch(error => setMessage(String(error))) }, [projectId, selectedId, advancedMode])
  useEffect(() => {
    void Promise.all([api.retrievalDiagnostics(), api.knowledgeDiagnostics()]).then(([retrievalValue, knowledgeValue]) => {
      setRetrieval(retrievalValue)
      setSearchMode(retrievalValue.default_mode)
      setKnowledge(knowledgeValue)
      setKnowledgeMode(knowledgeValue.latest_benchmark?.selected_default ?? 'legacy')
    }).catch(() => undefined)
  }, [])
  useEffect(() => {
    const active = jobs.some(job => !['awaiting_review', 'published', 'failed', 'canceled'].includes(job.status))
    if (!active) return
    const timer = setInterval(() => void reloadJobs().catch(() => undefined), 1200)
    return () => clearInterval(timer)
  }, [jobs, projectId, selectedId])

  const create = async (): Promise<void> => {
    setBusy(true); setMessage('正在打开 Windows 系统选择窗口，请查看前台窗口或任务栏。')
    try {
      const result = await api.ingestKnowledge({
        ...(projectId ? { project_id: projectId } : {}), input_value: inputValue,
        ...(inputAsset === null ? {} : { input_asset_id: inputAsset.asset.id }), ...(title.trim() ? { title } : {}),
        ...(inputAsset === null && sourceType !== 'auto' ? { source_type_override: sourceType } : {}),
      })
      setActiveIngestion(result)
      setSelectedIngestionTaskId(result.task.id)
      setIngestions(rows => [result.ingestion, ...rows.filter(item => item.id !== result.ingestion.id)])
      setMessage(result.message)
      if (result.video_job !== null) {
        setSelectedIngestionTaskId(null)
        setSelectedId(result.video_job.id)
        setJobs(rows => [result.video_job!, ...rows.filter(item => item.id !== result.video_job!.id)])
        setSelected(await api.videoJob(result.video_job.id))
      }
    } catch (error) { setMessage(friendlyVideoMessage(error)) }
    finally { setBusy(false) }
  }

  const chooseLocalInput = async (kind: 'file' | 'directory' = sourceType === 'local_folder' ? 'directory' : 'file'): Promise<void> => {
    setBusy(true); setMessage('')
    try {
      const selected = kind === 'directory' ? await api.selectDirectory() : await api.selectFile()
      if (selected.canceled || selected.asset === null) { setMessage('已经取消选择。'); return }
      setInputAsset(selected.asset)
      setInputValue(selected.asset.effective_path ?? '')
      setMessage(selected.asset.asset.input_type === 'directory' ? '本机文件夹已获得仅当前任务使用的访问授权。' : '本机文件已获得仅当前任务使用的访问授权。')
    } catch (error) { setMessage(friendlyVideoMessage(error)) }
    finally { setBusy(false) }
  }

  const search = async (): Promise<void> => {
    if (!query.trim()) return
    setBusy(true); setMessage('')
    try {
      setSearchResults(await api.searchVideo({
        query, ...(projectId ? { project_id: projectId } : {}), provider: searchMode,
        entity_type: searchEntityType, top_k: 8,
      }))
    }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const askDocument = async (): Promise<void> => {
    if (selectedDocument === null || !documentQuestion.trim()) return
    setBusy(true); setMessage('')
    try { setDocumentAnswer(await api.askDocument({ query: documentQuestion, document_id: selectedDocument.id, top_k: 5 })) }
    catch (error) { setMessage(friendlyVideoMessage(error)) }
    finally { setBusy(false) }
  }

  const publish = async (): Promise<void> => {
    if (selectedId === null) return
    setBusy(true); setMessage('')
    try { const result = await api.publishVideoJob(selectedId); setMessage(`已发布 ${result.published_segments} 个分段和 ${result.published_knowledge_points} 个知识点。`); await reloadJobs() }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const extractKnowledge = async (): Promise<void> => {
    if (selected?.document === null || selected?.document === undefined) return
    setBusy(true); setMessage('')
    try {
      const result = await api.extractKnowledge(selected.document.id)
      setMessage(`本机 qwen3:8b 已生成 ${result.cards.length} 张 staged Knowledge Card；旧知识点保持原样。`)
      setKnowledgeMode('structured')
      setKnowledge(await api.knowledgeDiagnostics())
      setSelected(await api.videoJob(selected.job.id))
    } catch (error) { setMessage(friendlyVideoMessage(error)) }
    finally { setBusy(false) }
  }

  const openKnowledgeCard = async (id: string): Promise<void> => {
    setBusy(true); setMessage('')
    try { setCardDetail(await api.knowledgeCard(id)) }
    catch (error) { setMessage(friendlyVideoMessage(error)) }
    finally { setBusy(false) }
  }

  const reviewKnowledgeCard = async (id: string, decision: KnowledgeCardReviewDecision): Promise<void> => {
    setBusy(true); setMessage('')
    try {
      setCardDetail(await api.reviewKnowledgeCard(id, decision, 'Personal Workbench 人工检查'))
      if (selected !== null) setSelected(await api.videoJob(selected.job.id))
      setMessage(`Knowledge Card 审核记录已保存：${decision}。`)
    } catch (error) { setMessage(friendlyVideoMessage(error)) }
    finally { setBusy(false) }
  }

  const regenerateKnowledgeCard = async (id: string): Promise<void> => {
    setBusy(true); setMessage('')
    try {
      const result = await api.regenerateKnowledgeCard(id)
      setCardDetail(await api.knowledgeCard(result.cards[0]!.id))
      if (selected !== null) setSelected(await api.videoJob(selected.job.id))
      setMessage('已经创建新的 Knowledge Card 版本，旧版本保留为 superseded。')
    } catch (error) { setMessage(friendlyVideoMessage(error)) }
    finally { setBusy(false) }
  }

  const selectedStage = selected?.job.stage ?? 'created'
  const selectedTaskId = selected?.job.task_id ?? jobs.find(job => job.id === selectedId)?.task_id ?? selectedIngestionTaskId ?? activeIngestion?.task.id ?? null
  const stageIndex = Math.max(0, PIPELINE.findIndex(([id]) => id === selectedStage))
  const asrExecution = selected?.document?.metadata.asr_execution as Record<string, unknown> | undefined
  const capabilityRows = useMemo(() => [
    { label: '网址获取', available: media?.downloader.available ?? false, detail: media?.downloader.executable ?? media?.downloader.reason ?? '检查中' },
    { label: '媒体探测', available: media?.ffprobe.available ?? false, detail: media?.ffprobe.executable ?? media?.ffprobe.reason ?? '检查中' },
    { label: '关键帧 OCR', available: media?.ocr.available ?? false, detail: media?.ocr.engine ?? media?.ocr.reason ?? '检查中' },
    { label: '本地 ASR', available: media?.asr.available ?? false, detail: media?.asr.available ? `${media.asr.device}/${media.asr.compute_type}` : media?.asr.reason ?? '本机 ASR 按顺序选择用户字幕、媒体字幕和本地转写' },
    { label: '本地检索', available: retrieval?.formal_provider_available ?? media?.embedding.available ?? true, detail: retrieval === null ? '检查中' : retrieval.formal_provider_available ? `${retrieval.model} · ${retrieval.dimension}维` : '基础本地检索模式' },
    { label: '文档处理', available: true, detail: 'PDF、Word、PowerPoint、Excel 只读解析' },
  ], [media, retrieval])

  return <div className="page-stack video-knowledge-page">
    <header className="page-heading"><div><Badge tone="blue">本机知识导入</Badge><h1>知识导入</h1><p>把文件、文件夹、公开链接或文字交给我，系统会自动判断处理方式并整理为学习资料。</p></div><Badge tone={media?.embedding.available ? 'green' : 'amber'}>本机处理</Badge></header>
    {advancedMode ? <div className="video-capability-grid">{capabilityRows.map(item => <article key={item.label}><span className={item.available ? 'video-capability-ok' : 'video-capability-warning'}>{item.available ? '✓' : '!'}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></article>)}</div> : <Panel title="本机处理环境" subtitle={capabilityRows.every(item => item.available) ? '可以使用' : '部分组件需要检查'}><details><summary>查看详情</summary><div className="video-capability-grid">{capabilityRows.map(item => <article key={item.label}><span className={item.available ? 'video-capability-ok' : 'video-capability-warning'}>{item.available ? '✓' : '!'}</span><div><strong>{item.label}</strong><small>{item.available ? '可以使用' : '需要检查'}</small></div></article>)}</div></details></Panel>}
    <Panel title="创建知识导入任务" subtitle="项目可以留空并使用 Personal Inbox；文件与文件夹通过系统窗口选择后才会获得本次任务授权。">
      <div className="video-create-form">
        <label><span>关联项目</span><select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Personal Inbox（临时任务）</option>{snapshot.projectContexts.filter(project => project.projectType !== 'personal').map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        {advancedMode ? <label><span>来源类型</span><select value={sourceType} onChange={event => { setSourceType(event.target.value as typeof sourceType); setInputValue(''); setInputAsset(null); setActiveIngestion(null); setMessage('') }}><option value="auto">自动识别（推荐）</option><option value="local_file">文件</option><option value="local_folder">文件夹</option><option value="video_url">视频网址</option><option value="web_url">网页网址</option><option value="github_repo">GitHub 仓库</option><option value="text_input">文本</option></select></label> : <div className="input-auto-detected"><strong>自动识别来源</strong><small>链接、文件和文字会自动进入合适的处理流程。</small></div>}
        <label className="video-input-wide"><span>输入</span><div className="video-input-picker">{sourceType === 'text_input' ? <textarea value={inputValue} onChange={event => { setInputValue(event.target.value); setInputAsset(null) }} placeholder={inputPlaceholder(sourceType, root)} /> : <input value={inputValue} onChange={event => { setInputValue(event.target.value); setInputAsset(null) }} placeholder={inputPlaceholder(sourceType, root)} />}{sourceType === 'auto' && <><button type="button" disabled={busy} onClick={() => void chooseLocalInput('file')}>选择文件</button><button type="button" disabled={busy} onClick={() => void chooseLocalInput('directory')}>选择文件夹</button></>}{(sourceType === 'local_file' || sourceType === 'local_folder') && <button type="button" disabled={busy} onClick={() => void chooseLocalInput()}>{sourceType === 'local_folder' ? '选择本机文件夹' : '选择本机文件'}</button>}</div>{inputAsset && <small>{inputAsset.asset.display_name} · {inputAsset.capability.label} · 临时授权 · 仅当前任务</small>}</label>
        <label><span>任务标题</span><input value={title} onChange={event => setTitle(event.target.value)} placeholder="可选" /></label>
        <button className="primary" disabled={busy || !inputValue.trim()} onClick={() => void create()}>开始知识导入</button>
      </div>
      {sourceType === 'video_url' && media?.downloader.available === false && <p className="video-component-notice">当前电脑尚未配置 yt-dlp，因此暂时不能处理视频网站地址。可以前往“设置”查看组件状态。</p>}
      {message && <p className={message.includes('暂时不能') || message.includes('缺少') || message.includes('尚未获得') ? 'error-banner' : 'success-banner'}>{message}</p>}
      {activeIngestion && <section className="ingestion-source-card"><strong>{activeIngestion.source.display_name}</strong><span>{advancedMode ? activeIngestion.source.source_type : '已开始处理'}</span>{advancedMode && <small>处理链路：{activeIngestion.ingestion.pipeline} · 任务：{activeIngestion.task.id}</small>}</section>}
      <p className="video-boundary-note">网页与 GitHub 只处理用户主动提交的公开链接。系统不会读取浏览器 Cookie、登录状态或仓库代码，也不会执行任何仓库脚本。</p>
    </Panel>
    <Panel title="最近任务" subtitle={advancedMode ? `${ingestions.length} 条已识别来源；公开网页与公开 GitHub 仓库会在受控范围内读取、清洗并生成资料。` : '最多显示最近 5 条，完整历史请前往任务与历史。'}>
      <div className="knowledge-ingestion-list">{ingestions.length === 0 ? <div className="empty-state"><strong>暂无知识输入</strong><p>选择文件、文件夹、网址或输入文本后，这里会显示处理结果。</p></div> : ingestions.map(item => <button key={item.id} className={selectedIngestionTaskId === item.task_id ? 'active' : ''} onClick={() => { setSelectedIngestionTaskId(item.task_id); setSelectedId(null); setSelected(null); setDocumentAnswer(null); void api.knowledgeIngestionDocument(item.id).then(setSelectedDocument).catch(() => setSelectedDocument(null)) }}><span><strong>{item.display_name}</strong><small>{advancedMode ? `${item.source_type} · ${item.pipeline} · ` : ''}{new Date(item.created_at).toLocaleString('zh-CN')}</small></span>{advancedMode && <i>{item.task_id}</i>}</button>)}</div>
    </Panel>
    <div className="video-layout">
      <Panel title={advancedMode ? 'Video Knowledge 任务与状态' : '视频相关任务'} subtitle={advancedMode ? `${jobs.length} 个视频知识任务` : '最多显示最近 3 条'}><div className="video-job-list">{jobs.length === 0 ? <div className="empty-state"><strong>暂无视频任务</strong><p>视频网址、视频文件、音频或字幕会继续进入现有视频知识流水线。</p></div> : jobs.map(job => <button key={job.id} className={selectedId === job.id ? 'active' : ''} onClick={() => { setSelectedId(job.id); setSelectedIngestionTaskId(null) }}><span><strong>{job.title}</strong><small>{advancedMode ? `${job.input_type} · ` : ''}{new Date(job.created_at).toLocaleString('zh-CN')}</small></span><span><Badge tone={job.status === 'failed' ? 'red' : job.status === 'published' ? 'green' : job.status === 'awaiting_review' ? 'amber' : 'blue'}>{job.status === 'awaiting_review' && !advancedMode ? '待确认' : job.status === 'failed' ? '处理失败' : job.status === 'published' ? '已完成' : '处理中'}</Badge>{advancedMode && <i>{job.stage}</i>}</span></button>)}</div></Panel>
      <Panel title="处理进度" subtitle={selected === null ? '选择一个任务查看真实状态' : `当前阶段：${selected.job.stage}`}>
        <div className="video-pipeline">{PIPELINE.map(([id, label], index) => <div key={id} className={index < stageIndex ? 'done' : index === stageIndex ? 'active' : ''}><i>{index < stageIndex ? '✓' : index + 1}</i><span>{label}</span></div>)}</div>
        {selected?.job.error_code && <p className="error-banner"><strong>{selected.job.error_code}</strong> · {selected.job.error_message}</p>}
        {selected?.document && <div className="video-document-summary"><div><span>文档</span><strong>{selected.document.title}</strong></div><div><span>分段</span><strong>{selected.document.segment_count}</strong></div><div><span>Legacy知识点</span><strong>{selected.document.knowledge_point_count}</strong></div><div><span>Knowledge Cards</span><strong>{selected.knowledge_cards.length}</strong></div><div><span>转录来源</span><strong>{String(selected.document.metadata.transcript_source ?? '—')}</strong></div><div><span>ASR Device</span><strong>{asrExecution === undefined ? '未调用 ASR' : `${String(asrExecution.resolved_device ?? '—')} / ${String(asrExecution.compute_type ?? '—')}`}</strong></div><div><span>GPU回退</span><strong>{asrExecution?.fallback_used === true ? String(asrExecution.fallback_reason ?? '已使用CPU') : '未发生'}</strong></div><div><span>时长</span><strong>{Number((selected.document.metadata.media_probe as Record<string, unknown> | undefined)?.duration_seconds ?? 0).toFixed(2)} 秒</strong></div><div><span>视频编码</span><strong>{String((selected.document.metadata.media_probe as Record<string, unknown> | undefined)?.video_codec ?? '无')}</strong></div><div><span>音频编码</span><strong>{String((selected.document.metadata.media_probe as Record<string, unknown> | undefined)?.audio_codec ?? '—')}</strong></div><div><span>Memory</span><strong>{selected.document.memory_state}</strong></div></div>}
        {selected && <div className="video-runtime-log"><h3>媒体日志</h3>{selected.logs.length === 0 ? <p className="muted">尚无执行日志。</p> : selected.logs.map((entry, index) => <article key={`${entry.timestamp}-${index}`}><time>{new Date(entry.timestamp).toLocaleTimeString('zh-CN')}</time><strong>{entry.stage}</strong><span>{entry.message}</span>{entry.duration_ms !== undefined && <small>{entry.duration_ms} ms</small>}</article>)}</div>}
        {selectedTaskId !== null && <TaskRuntimePanel taskId={selectedTaskId} title={selected?.job.title ?? activeIngestion?.task.title ?? '知识导入任务'} compact={!advancedMode} />}
        {selectedTaskId !== null && selected === null && <LearningDocumentPanel taskId={selectedTaskId} />}
      </Panel>
    </div>
    {selectedDocument !== null && <Panel title="问这份资料" subtitle="回答只依据本机资料索引中的相关片段，并附带页码、课件页或章节来源。">
      <div className="search-bar"><input value={documentQuestion} onChange={event => setDocumentQuestion(event.target.value)} placeholder={`例如：${selectedDocument.title} 的核心概念在哪一页？`} /><button className="primary" disabled={busy || !documentQuestion.trim()} onClick={() => void askDocument()}>提问</button></div>
      {documentAnswer !== null && <div className="video-search-results"><article><p>{documentAnswer.answer}</p><div className="retrieval-citations">{documentAnswer.citations.map((citation, index) => <code key={`${citation.source_anchor}-${index}`}>{citation.title} · {citation.section} · {citation.source_anchor}</code>)}</div></article></div>}
    </Panel>}
    {selected?.document && <>
      <Panel title="章节与时间轴" subtitle="章节由确定性分段生成，时间戳来自字幕。"><div className="video-chapters">{selected.chapters.map(chapter => <article key={chapter.index}><time>{time(chapter.start_ms)} – {time(chapter.end_ms)}</time><strong>{chapter.title}</strong><small>{chapter.segment_ids.length} 个分段</small></article>)}</div></Panel>
      {selected.job.task_id !== null && <LearningDocumentPanel taskId={selected.job.task_id} />}
      <KnowledgeCardsPanel
        legacy={selected.knowledge_points.slice(0, 20)} cards={selected.knowledge_cards.slice(0, 40)} mode={knowledgeMode}
        selected={cardDetail} busy={busy} defaultMode={knowledge?.latest_benchmark?.selected_default ?? 'legacy'}
        onMode={setKnowledgeMode} onExtract={() => void extractKnowledge()} onOpen={id => void openKnowledgeCard(id)}
        onReview={(id, decision) => void reviewKnowledgeCard(id, decision)} onRegenerate={id => void regenerateKnowledgeCard(id)}
      />
      <Panel title="Artifact 与审核" subtitle="结构化知识批次单独登记 Artifact，并继续通过 Evidence 与人工审核流程。"><div className="video-artifacts">{selected.artifacts.map(artifact => <article key={artifact.id}><span><strong>{artifact.name}</strong><small>{artifact.artifact_type} · {artifact.status}</small></span><code>{artifact.sha256.slice(0, 12)}</code></article>)}</div><button className="primary" disabled={busy || selected.document.memory_state === 'published'} onClick={() => void publish()}>审核通过后发布到项目记忆</button><p className="muted">Knowledge Card 默认保持 staged；结构化提取不会自动写入长期 Research Memory。</p></Panel>
    </>}
    <Panel title="视频知识检索" subtitle="语义检索与基础本地检索使用同一批 Segment、时间戳、Artifact 和 Evidence。">
      <div className="retrieval-toolbar">
        <label><span>检索模式</span><select value={searchMode} onChange={event => setSearchMode(event.target.value as typeof searchMode)}><option value="semantic">语义检索</option><option value="local-hash-v1">基础本地检索</option></select></label>
        <label><span>实体范围</span><select value={searchEntityType} onChange={event => setSearchEntityType(event.target.value as typeof searchEntityType)}><option value="all">全部表示</option><option value="knowledge_card">Knowledge Card</option><option value="knowledge_point">Legacy Knowledge Point</option><option value="video_segment">Video Segment</option></select></label>
        <div className="retrieval-runtime-inline"><Badge tone={retrieval?.formal_provider_available ? 'green' : 'amber'}>{retrieval?.formal_provider_available ? 'Embedding Available' : 'Fallback Available'}</Badge><small>{retrieval?.model ?? '读取运行状态中'}</small></div>
      </div>
      <div className="search-bar"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="例如：为什么无线通信需要两路正交分量" /><button className="primary" disabled={busy || !query.trim()} onClick={() => void search()}>搜索</button></div>
      {searchResults[0]?.fallback_used && <p className="video-component-notice">正式 Embedding 当前不可用，结果来自基础本地检索。原因：{searchResults[0].fallback_reason}</p>}
      <div className="video-search-results">{searchResults.map(result => <article key={`${result.entity_type}-${result.entity_id}`}>
        <header><div><strong>{result.title}</strong><span><Badge tone={result.provider === 'ollama' ? 'green' : 'amber'}>{result.provider === 'ollama' ? '语义检索' : '基础检索'}</Badge><Badge tone={result.index_state === 'approved' ? 'green' : 'blue'}>{result.index_state}</Badge></span></div><time>{time(result.start_ms)} – {time(result.end_ms)}</time></header>
        {result.structured_card === null ? <p>{result.text}</p> : <div className="search-knowledge-card"><strong>{result.structured_card.core_claim}</strong><p>{result.structured_card.explanation}</p><div className="knowledge-keywords">{result.structured_card.keywords.map(keyword => <span key={keyword}>{keyword}</span>)}</div></div>}
        <div className="retrieval-result-meta"><span>相关度 <b>{result.score.toFixed(4)}</b></span><span>{result.entity_type === 'video_segment' ? 'Video Segment' : result.entity_type === 'knowledge_card' ? 'Knowledge Card' : 'Legacy Knowledge Point'}</span><span>{result.transcript_source}</span><span>{result.dimension}维</span></div>
        <div className="retrieval-citations"><code>{result.video_citation}</code><code>{result.segment_citation}</code>{result.knowledge_citation && <code>{result.knowledge_citation}</code>}{result.card_citation && <code>{result.card_citation}</code>}</div>
        <div className="retrieval-result-actions">
          <details><summary>查看来源 Segment</summary><p>{result.text}</p><code>{result.segment_citation}</code></details>
          <details><summary>查看证据</summary>{result.evidence_summary.length === 0 ? <p>当前结果尚未关联 Evidence。</p> : <ul>{result.evidence_summary.map((evidence, index) => <li key={`${evidence.source_type}-${evidence.source_id}-${index}`}><code>{evidence.source_type}:{evidence.source_id}</code><span>{evidence.relation_type}</span></li>)}</ul>}</details>
        </div>
        <footer><span>Artifact：{result.artifact_name ?? result.artifact_id ?? '尚未关联'}</span><span>Evidence：{result.evidence_count} 条</span><button type="button" onClick={() => navigator.clipboard.writeText(result.citation)}>复制时间引用</button></footer>
      </article>)}</div>
    </Panel>
    {developerMode && <Panel title="Legacy复用审计" subtitle="媒体脚本没有被直接迁移；当前只沿用经过审计的任务状态语义。"><pre>{JSON.stringify(snapshot.legacy, null, 2)}</pre></Panel>}
  </div>
}
