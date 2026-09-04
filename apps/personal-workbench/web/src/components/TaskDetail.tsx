import { useEffect, useMemo, useState } from 'react'
import type { ArtifactCandidate, ArtifactEvidenceBundle, ArtifactEvidenceCreateInput, ArtifactPreview, ArtifactRecord, DatabaseRole, InputAssetView, MemoryEntityType, TaskEvent, VideoJobView, WorkbenchTask } from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import { Badge, EmptyState, formatBytes, formatDuration, Panel } from './common.tsx'
import { TaskRuntimePanel } from './TaskRuntimePanel.tsx'
import { LearningDocumentPanel } from './LearningDocumentPanel.tsx'
import { DocumentStudyPanel } from './DocumentStudyPanel.tsx'

const TABS = ['回答', '执行过程', '工具调用', '产物', '引用与证据', '运行信息'] as const

function eventLabel(event: TaskEvent): string {
  const labels: Record<string, string> = {
    'request/header': '模型请求', 'request/context': '上下文配置', 'tool/call': '工具调用', 'tool/result': '工具结果',
    'assistant/message': '助手消息', 'turn/end': '轮次完成', 'task.running': '任务运行', 'task.completed': '任务完成', 'harness.ready': 'Session 已创建',
    'artifact.candidates': '发现产物候选', 'artifact.registered': '产物索引已登记', 'artifact.discovery_failed': '产物候选检查失败',
    'artifact.report_candidate_created': '回答报告候选已生成', 'artifact.report_saved': '回答报告已登记', 'artifact.word_exported': 'Word 报告已导出',
    'task.project_context_assigned': '已分配 Personal Inbox',
    'input.asset_created': '输入资产已登记', 'input.grant_created': '临时授权已创建',
    'input.grant_attached': '临时授权已关联任务', 'input.staged': '分析副本已暂存', 'input.grant_expired': '临时授权已失效',
    'video.created': '视频任务已创建', 'video.source_detected': '视频来源已识别', 'video.media_probe': '媒体探测', 'video.download': '媒体下载',
    'video.audio_extract': '音轨提取', 'video.asr': '本机 ASR', 'video.frame_extract': '关键帧抽取', 'video.ocr': '关键帧 OCR',
    'video.fusion': 'ASR 与 OCR 融合', 'video.term_correction': '专业术语校正', 'video.segment': '时间轴分段', 'video.knowledge_extract': '知识提取',
    'video.artifact_generate': 'Artifact 与 Evidence 生成', 'video.review': '进入人工审核', 'video.runtime_stage': '视频运行阶段',
  }
  return labels[event.eventType] ?? event.eventType
}

function isArtifactCandidate(value: unknown): value is ArtifactCandidate {
  if (value === null || typeof value !== 'object') return false
  const row = value as Partial<ArtifactCandidate>
  return typeof row.absolute_path === 'string' && typeof row.relative_path === 'string' && typeof row.artifact_type === 'string'
}

function citationEvidence(value: string, role: DatabaseRole): { key: string; label: string; input: ArtifactEvidenceCreateInput } | null {
  const chunk = value.match(/^\[Chunk:([0-9a-f]{64})\s/iu)
  if (chunk !== null) return { key: `chunk:${chunk[1]}`, label: value, input: { source_type: 'document_chunk', source_id: chunk[1]!, relation_type: 'references', database_role: role } }
  const memory = value.match(/^\[Memory:(project|decision|experiment|document|task|session)#([^\]]+)\]$/iu)
  if (memory !== null) return { key: `memory:${memory[1]}:${memory[2]}`, label: value, input: { source_type: 'memory', source_id: memory[2]!, relation_type: 'references', database_role: role, memory_type: memory[1]!.toLowerCase() as MemoryEntityType } }
  const source = value.match(/^\[Source:([^\s\]]+)/u)
  if (source !== null) return { key: `source:${source[1]}`, label: value, input: { source_type: 'source', source_id: source[1]!, relation_type: 'verified_by', database_role: role } }
  return null
}

export function TaskDetail({ taskId, advancedMode = false, onClose, onOpenTask }: { taskId: string; advancedMode?: boolean; onClose?: () => void; onOpenTask?: (id: string) => void }): JSX.Element {
  const [task, setTask] = useState<WorkbenchTask | null>(null)
  const [inputAsset, setInputAsset] = useState<InputAssetView | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([])
  const [candidates, setCandidates] = useState<ArtifactCandidate[]>([])
  const [tab, setTab] = useState<(typeof TABS)[number]>('回答')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [registering, setRegistering] = useState<string | null>(null)
  const [savingReport, setSavingReport] = useState(false)
  const [exportingWord, setExportingWord] = useState(false)
  const [preview, setPreview] = useState<ArtifactPreview | null>(null)
  const [evidence, setEvidence] = useState<ArtifactEvidenceBundle | null>(null)
  const [autoLinkTask, setAutoLinkTask] = useState(true)
  const [autoLinkSession, setAutoLinkSession] = useState(true)
  const [selectedCitationEvidence, setSelectedCitationEvidence] = useState<string[]>([])
  const [knowledgeCards, setKnowledgeCards] = useState<VideoJobView['knowledge_cards']>([])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = async () => {
      try {
        const value = await api.task(taskId)
        if (!disposed) {
          setTask(value.task)
          setEvents(value.events)
          setArtifacts(value.artifacts)
          setCandidates(value.artifactCandidates.filter(isArtifactCandidate))
          setInputAsset(value.input)
        }
        if (!disposed && !['completed', 'failed', 'canceled'].includes(value.task.status)) timer = setTimeout(load, 900)
      } catch (caught) { if (!disposed) setError(String(caught)) }
    }
    void load()
    return () => { disposed = true; if (timer !== null) clearTimeout(timer) }
  }, [taskId])

  const toolEvents = useMemo(() => events.filter(item => item.eventType === 'tool/call' || item.eventType === 'tool/result' || item.eventType.includes('tool')), [events])
  const evidenceCandidates = useMemo(() => {
    const role: DatabaseRole = task?.metadata.databaseRole === 'test' ? 'test' : 'production'
    return task?.citationIndex.map(item => citationEvidence(item, role)).filter((item): item is NonNullable<typeof item> => item !== null) ?? []
  }, [task])
  if (task === null) return <Panel title="任务详情"><EmptyState icon="⌛" title="正在读取任务" detail={error || '正在取得 Session 与事件。'} /></Panel>

  const registerCandidate = async (candidate: ArtifactCandidate) => {
    setRegistering(candidate.absolute_path); setError(''); setNotice('')
    try {
      const artifact = await api.registerArtifact({
        project_id: candidate.project_id,
        task_id: candidate.task_id,
        file_path: candidate.absolute_path,
        artifact_type: candidate.artifact_type,
        name: candidate.name,
        metadata: { origin: 'task-output-candidate' },
        auto_link_task: autoLinkTask,
        auto_link_session: autoLinkSession,
        evidence: evidenceCandidates.filter(item => selectedCitationEvidence.includes(item.key)).map(item => item.input),
      })
      setArtifacts(rows => [artifact, ...rows.filter(item => item.id !== artifact.id)])
      setCandidates(rows => rows.map(item => item.absolute_path === candidate.absolute_path ? { ...item, registered_artifact_id: artifact.id } : item))
      setNotice(`产物索引已经登记：${artifact.name}`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setRegistering(null) }
  }

  const saveAnswerReport = async () => {
    setSavingReport(true); setError(''); setNotice('')
    try {
      const result = await api.saveTaskAnswerReport(task.id, {
        auto_link_task: autoLinkTask,
        auto_link_session: autoLinkSession,
        evidence: evidenceCandidates.filter(item => selectedCitationEvidence.includes(item.key)).map(item => item.input),
      })
      setArtifacts(rows => [result.artifact, ...rows.filter(item => item.id !== result.artifact.id)])
      setCandidates(rows => rows.filter(item => item.absolute_path !== result.candidate.absolute_path))
      const refreshed = await api.task(task.id)
      setTask(refreshed.task)
      setEvents(refreshed.events)
      setNotice(`回答已经保存并登记为 Artifact，已建立 ${result.evidence_count} 条 Evidence。`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setSavingReport(false) }
  }

  const exportAnswerWord = async () => {
    setExportingWord(true); setError(''); setNotice('')
    try {
      const result = await api.exportTaskAnswerWord(task.id, {
        auto_link_task: autoLinkTask,
        auto_link_session: autoLinkSession,
        evidence: evidenceCandidates.filter(item => selectedCitationEvidence.includes(item.key)).map(item => item.input),
      })
      setArtifacts(rows => [result.word_artifact, result.markdown_artifact, ...rows.filter(item => item.id !== result.word_artifact.id && item.id !== result.markdown_artifact.id)])
      const refreshed = await api.task(task.id)
      setTask(refreshed.task)
      setEvents(refreshed.events)
      setNotice(`Word 报告已经导出并登记为 Artifact，已建立 ${result.evidence_count} 条 Evidence。`)
      setTab('产物')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setExportingWord(false) }
  }

  const viewKnowledgeCards = async () => {
    const jobId = typeof task.metadata.jobId === 'string' ? task.metadata.jobId : null
    if (jobId === null) { setNotice('此任务没有产生 Video Knowledge Card。'); return }
    setRegistering('knowledge-cards'); setError(''); setNotice('')
    try {
      const job = await api.videoJob(jobId)
      setKnowledgeCards(job.knowledge_cards)
      setTab('产物')
      setNotice(`已载入 ${job.knowledge_cards.length} 张 Knowledge Card。`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setRegistering(null) }
  }

  const viewEvidenceForTask = async () => {
    setTab('产物')
    const primary = artifacts[0]
    if (primary === undefined) { setNotice('当前任务尚未登记 Artifact，因此没有可展示的 Evidence。'); return }
    await showEvidence(primary)
  }

  const previewArtifact = async (artifact: ArtifactRecord) => {
    setRegistering(`preview:${artifact.id}`); setError(''); setNotice('')
    try { setPreview(await api.previewArtifact(artifact.id)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setRegistering(null) }
  }

  const openArtifactLocation = async (artifact: ArtifactRecord) => {
    setRegistering(`open:${artifact.id}`); setError(''); setNotice('')
    try { await api.openArtifactLocation(artifact.id); setNotice(`已经打开文件位置：${artifact.name}`) }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setRegistering(null) }
  }

  const showEvidence = async (artifact: ArtifactRecord) => {
    setRegistering(`evidence:${artifact.id}`); setError(''); setNotice('')
    try { setEvidence(await api.artifactEvidence(artifact.id)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setRegistering(null) }
  }

  const removeEvidence = async (id: string) => {
    if (evidence === null) return
    setRegistering(`delete-evidence:${id}`); setError(''); setNotice('')
    try {
      await api.deleteArtifactEvidence(id)
      setEvidence(await api.artifactEvidence(evidence.artifact.id))
      setNotice('Evidence 关系已经移除，来源与 Artifact 保持原状。')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setRegistering(null) }
  }

  const body = (() => {
    if (tab === '回答') return <div className="answer-view">
      {task.resultText ? <pre>{task.resultText}</pre> : <EmptyState icon="◌" title="回答尚未形成" detail={task.status === 'running' ? '本地模型正在处理任务。' : task.errorMessage ?? '任务等待运行。'} />}
    </div>
    if (tab === '执行过程') return <div className="timeline">{events.map(event => <article key={event.id} className="timeline-item"><i /><div><strong>{eventLabel(event)}</strong><span>{new Date(event.createdAt).toLocaleTimeString()}</span><details><summary>查看事件</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details></div></article>)}</div>
    if (tab === '工具调用') return toolEvents.length === 0 ? <EmptyState icon="⌘" title="当前没有工具事件" detail="纯文本任务可能直接形成回答。" /> : <div className="event-grid">{toolEvents.map(event => <article className="event-card" key={event.id}><Badge tone={event.eventType === 'tool/call' ? 'blue' : 'green'}>{eventLabel(event)}</Badge><pre>{JSON.stringify(event.payload, null, 2)}</pre></article>)}</div>
    if (tab === '产物') return <div className="task-artifact-context">
      <div className="task-artifact-actions"><div><strong>任务回答产物化</strong><span>保存后生成 Markdown 报告；导出 Word 会复用该报告并建立独立 Artifact。临时任务自动归入 Personal Inbox。</span></div><div className="artifact-task-row-actions"><button className="primary" disabled={savingReport || exportingWord || task.status !== 'completed' || task.resultText === null} onClick={() => void saveAnswerReport()}>{savingReport ? '正在生成…' : '保存回答为报告'}</button><button disabled={savingReport || exportingWord || task.status !== 'completed' || task.resultText === null} onClick={() => void exportAnswerWord()}>{exportingWord ? '正在导出 Word…' : '导出 Word'}</button></div></div>
      <div className="artifact-evidence-options"><strong>保存报告时关联 Evidence</strong><label><input type="checkbox" checked={autoLinkTask} onChange={event => setAutoLinkTask(event.target.checked)} /> 当前 Task（generated_from）</label><label><input type="checkbox" checked={autoLinkSession && task.harnessSessionId !== null} disabled={task.harnessSessionId === null} onChange={event => setAutoLinkSession(event.target.checked)} /> 当前 Session（created_by）</label>{evidenceCandidates.map(item => <label key={item.key}><input type="checkbox" checked={selectedCitationEvidence.includes(item.key)} onChange={event => setSelectedCitationEvidence(values => event.target.checked ? [...values, item.key] : values.filter(value => value !== item.key))} /> {item.label}</label>)}</div>
      <div className="artifact-io-grid">
        <section><span>输入</span><strong>{task.inputValue}</strong><small>{task.workspacePath ?? '未设置工作区'}</small></section>
        <section><span>输出</span><strong>{task.status === 'completed' ? '任务结果已形成' : `任务状态：${task.status}`}</strong><small>{task.resultText === null ? '当前没有文本结果' : `${task.resultText.length} 个字符`}</small></section>
      </div>
      <section className="artifact-section"><header><div><h3>生成文件</h3><p>候选来自工作区内固定的 output/outputs 目录，确认后才写入索引。</p></div><Badge tone="blue">{artifacts.length} 已登记</Badge></header>
        {artifacts.length === 0 && candidates.length === 0 ? <EmptyState icon="□" title="暂无产物。" detail="任务完成后会检查受控输出目录，也可以从项目页面登记已有文件。" /> : <div className="artifact-list">
          {artifacts.map(artifact => <article key={artifact.id}><div><Badge tone={artifact.status === 'active' ? 'green' : artifact.status === 'missing' ? 'red' : artifact.status === 'outdated' ? 'amber' : 'neutral'}>{artifact.status}</Badge><strong>{artifact.name}</strong><code>{artifact.relative_path}</code></div><span>{formatBytes(artifact.size_bytes)} · {artifact.version_count} 个版本</span><small>SHA-256 {artifact.sha256.slice(0, 12)}…</small><div className="artifact-task-row-actions"><button disabled={registering !== null || artifact.status === 'missing'} onClick={() => void previewArtifact(artifact)}>预览</button><button disabled={registering !== null} onClick={() => void showEvidence(artifact)}>Evidence</button><button disabled={registering !== null || artifact.status === 'missing'} onClick={() => void openArtifactLocation(artifact)}>打开文件位置</button></div></article>)}
          {candidates.filter(candidate => candidate.registered_artifact_id === null).map(candidate => <article className="artifact-candidate" key={candidate.absolute_path}><div><Badge tone="amber">候选 · {candidate.artifact_type}</Badge><strong>{candidate.name}</strong><code>{candidate.relative_path}</code></div><span>{formatBytes(candidate.size_bytes)}</span><button disabled={registering !== null} onClick={() => void registerCandidate(candidate)}>{registering === candidate.absolute_path ? '登记中…' : '确认登记'}</button></article>)}
        </div>}
      </section>
      {preview && <section className="artifact-intelligence-detail task-artifact-preview"><header><div><Badge tone="blue">只读预览</Badge><strong>{preview.artifact.name}</strong></div><button onClick={() => setPreview(null)}>关闭</button></header>{preview.preview_type === 'image' ? <p>{preview.mime} · {preview.width} × {preview.height}</p> : <pre>{preview.content}</pre>}{preview.truncated && <small>内容已按 100KB 上限截断。</small>}</section>}
      {evidence && <section className="artifact-intelligence-detail artifact-evidence-detail"><header><div><Badge tone="blue">Evidence</Badge><strong>{evidence.artifact.name}</strong><span>{evidence.count} 条关系</span></div><button onClick={() => setEvidence(null)}>关闭</button></header>{evidence.evidence.length === 0 ? <p className="muted">当前没有 Evidence 关系。</p> : <div className="artifact-evidence-list">{evidence.evidence.map(link => <article key={link.id}><div><Badge tone="neutral">{link.relation_type}</Badge><strong>{link.source.label}</strong><code>{link.source_type}:{link.source_id}</code></div><button disabled={registering !== null} onClick={() => void removeEvidence(link.id)}>移除关系</button></article>)}</div>}</section>}
      {knowledgeCards.length > 0 && <section className="artifact-intelligence-detail task-knowledge-cards"><header><div><Badge tone="blue">Knowledge Card</Badge><strong>当前任务产生的结构化知识</strong><span>{knowledgeCards.length} 张</span></div><button onClick={() => setKnowledgeCards([])}>关闭</button></header>{knowledgeCards.map(card => <article key={card.id}><strong>{card.title}</strong><p>{card.core_claim}</p><small>{card.concept} · {card.source_start}–{card.source_end} · {card.status}</small></article>)}</section>}
      <section className="artifact-section referenced-files"><header><div><h3>引用文件</h3><p>这里只显示任务输入与回答中已经提取的引用。</p></div></header>{task.citationIndex.length === 0 ? <p className="muted">当前没有文件引用。</p> : <ul>{task.citationIndex.map(item => <li key={item}><code>{item}</code></li>)}</ul>}</section>
      {notice && <p className="success-banner">{notice}</p>}{error && <p className="error-banner">{error}</p>}
    </div>
    if (tab === '引用与证据') return task.citationIndex.length === 0 ? <EmptyState icon="⌁" title="尚无已提取引用" detail="引用会从最终回答中的 Memory、Source、Chunk 和文件定位提取。" /> : <ul className="citation-list">{task.citationIndex.map(item => <li key={item}><button onClick={() => void navigator.clipboard.writeText(item)}>复制</button><code>{item}</code></li>)}</ul>
    return <dl className="run-info">
      <div><dt>Workbench任务</dt><dd>{task.id}</dd></div><div><dt>Harness Session</dt><dd>{task.harnessSessionId ?? '—'}</dd></div>
      <div><dt>模型</dt><dd>{String(task.metadata.model ?? '—')}</dd></div><div><dt>执行通道</dt><dd>{String(task.metadata.execution ?? '—')}</dd></div>
      <div><dt>权限</dt><dd>{task.permissionMode}</dd></div><div><dt>耗时</dt><dd>{formatDuration(task.startedAt, task.completedAt)}</dd></div>
      <div><dt>Context</dt><dd>{String(task.metadata.contextWindow ?? '—')}</dd></div><div><dt>运行进程</dt><dd>{task.runtimePid ?? '—'}</dd></div>
      <div><dt>Project Context</dt><dd>{task.projectId ?? '未关联'}</dd></div><div><dt>工作区</dt><dd>{task.workspacePath ?? '—'}</dd></div>
    </dl>
  })()

  const cancel = async () => setTask(await api.cancelTask(task.id))
  const retry = async () => { const created = await api.retryTask(task.id); await api.startTask(created.id); onOpenTask?.(created.id) }
  return <Panel title={task.title} subtitle={`${task.templateId} · ${task.status}`} action={<div className="panel-actions"><Badge tone={task.status === 'completed' ? 'green' : task.status === 'failed' ? 'red' : 'blue'}>{task.status}</Badge>{['starting', 'running', 'queued'].includes(task.status) && <button className="icon-button" onClick={() => void cancel()}>取消</button>}{['completed', 'failed', 'canceled'].includes(task.status) && <button className="icon-button" onClick={() => void retry()}>重试</button>}{onClose && <button className="icon-button" onClick={onClose}>关闭</button>}</div>}>
    {inputAsset && <section className="task-input-source"><div><span>输入</span><strong>{inputAsset.asset.display_name}</strong></div><div><span>来源</span><strong>{inputAsset.asset.source_mode === 'native_picker' ? '系统文件选择器' : '拖放分析副本'}</strong></div><div><span>访问方式</span><strong>{inputAsset.asset.access_mode === 'temporary_grant' ? `临时授权 · ${inputAsset.grant?.scope ?? '已失效'}` : 'Personal Inbox 分析副本'}</strong></div><div><span>Project / 报告位置</span><strong>{task.projectName ?? 'Personal Inbox'} · Personal Inbox/output</strong></div></section>}
    {task.status === 'completed' && <section className="task-completion-outputs"><div><strong>报告与产物</strong><span>任务已经完成，可在此直接查看报告、导出 Word、查看知识卡和来源 Evidence。</span></div><div className="artifact-task-row-actions"><button onClick={() => setTab('产物')}>查看报告</button><button className="primary" disabled={exportingWord || savingReport || task.resultText === null} onClick={() => void exportAnswerWord()}>{exportingWord ? '正在导出 Word…' : '导出 Word'}</button><button disabled={registering !== null} onClick={() => void viewKnowledgeCards()}>查看 Knowledge Card</button><button disabled={registering !== null} onClick={() => void viewEvidenceForTask()}>查看 Evidence</button></div></section>}
    <TaskRuntimePanel taskId={task.id} title={task.title} compact={!advancedMode} />
    {(task.status === 'completed' || task.status === 'canceled') && <LearningDocumentPanel taskId={task.id} resumable={task.status === 'canceled'} />}
    <DocumentStudyPanel taskId={task.id} advancedMode={advancedMode} />
    <div className="tabs">{(advancedMode ? TABS : TABS.filter(item => ['回答', '执行过程', '产物'].includes(item))).map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
    <div className="tab-content">{body}</div>
  </Panel>
}
