import { useEffect, useState } from 'react'
import type { LearningDocumentDetailLevel, LearningDocumentMode, LearningDocumentRecord } from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import { Badge, EmptyState } from './common.tsx'

const MODES: Array<[LearningDocumentMode, string]> = [
  ['learning_notes', '学习笔记'], ['review_notes', '复习资料'], ['technical_guide', '技术说明'], ['simple_summary', '简要总结'],
]

const DETAILS: Array<[LearningDocumentDetailLevel, string]> = [['concise', '简洁'], ['standard', '标准'], ['detailed', '详细']]

function learnerFacingError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  const humanMessage = message.replace(/^LEARNING_DOCUMENT_[A-Z_]+:\s*/u, '')
  return humanMessage === message && /^LEARNING_DOCUMENT_/u.test(message)
    ? '学习资料生成失败；任务内容已经保留，可以重新生成。'
    : humanMessage
}

export function LearningDocumentPanel({ taskId, compact = false, resumable = false }: { taskId: string; compact?: boolean; resumable?: boolean }): JSX.Element {
  const [documents, setDocuments] = useState<LearningDocumentRecord[]>([])
  const [mode, setMode] = useState<LearningDocumentMode>('learning_notes')
  const [detail, setDetail] = useState<LearningDocumentDetailLevel>('standard')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    try { setDocuments(await api.learningDocuments(taskId)) } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }
  useEffect(() => { void load() }, [taskId])

  const generate = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const latest = documents[0]
      const created = resumable
        ? await api.resumeLearningDocument({ task_id: taskId, document_mode: mode, detail_level: detail })
        : latest === undefined
        ? await api.generateLearningDocument({ task_id: taskId, document_mode: mode, detail_level: detail })
        : await api.regenerateLearningDocument(latest.id, { document_mode: mode, detail_level: detail })
      setDocuments(rows => [created, ...rows])
      setNotice('学习资料已生成，可以直接打开 Word 文档。')
    } catch (caught) { setError(learnerFacingError(caught)) }
    finally { setBusy(false) }
  }

  const open = async (document: LearningDocumentRecord, location: boolean) => {
    const artifactId = document.docx_artifact_id
    if (artifactId === null) return
    setBusy(true); setError(''); setNotice('')
    try {
      await (location ? api.openArtifactLocation(artifactId) : api.openArtifactFile(artifactId))
      setNotice(location ? '已经打开 Word 文档所在文件夹。' : '已经交给系统默认 Word 阅读器打开。')
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }

  const latest = documents[0]
  return <section className={`learning-document-panel${compact ? ' compact' : ''}`}>
    <header><div><Badge tone="green">学习资料</Badge><h3>{latest === undefined ? '生成学习笔记' : '学习资料已生成'}</h3><p>默认输出为可直接打开的 Word 文档；内容只使用本任务已经提取的资料。</p></div></header>
    <div className="learning-document-options"><label><span>资料类型</span><select value={mode} onChange={event => setMode(event.target.value as LearningDocumentMode)}>{MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>内容层级</span><select value={detail} onChange={event => setDetail(event.target.value as LearningDocumentDetailLevel)}>{DETAILS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="primary" disabled={busy} onClick={() => void generate()}>{busy ? '正在生成…' : resumable ? '继续处理' : latest === undefined ? '生成学习笔记' : '重新生成'}</button></div>
    {latest === undefined ? <EmptyState icon="▤" title="尚未生成学习资料" detail="任务完成后可在这里组织学习笔记、重点与复习问题。" /> : <div className="learning-document-output"><div><strong>{latest.document_title}.docx</strong><span>{MODES.find(item => item[0] === latest.document_mode)?.[1] ?? latest.document_mode} · {DETAILS.find(item => item[0] === latest.detail_level)?.[1] ?? latest.detail_level}</span><p>{latest.summary}</p></div><div className="artifact-task-row-actions"><button className="primary" disabled={busy || latest.docx_artifact_id === null} onClick={() => void open(latest, false)}>打开 Word 文档</button><button disabled={busy || latest.docx_artifact_id === null} onClick={() => void open(latest, true)}>打开所在文件夹</button><details><summary>查看来源</summary><ul>{latest.references.map((reference, index) => <li key={`${reference.label}-${index}`}><strong>{reference.label}</strong>{reference.time_range && <span> · {reference.time_range}</span>}<small>{reference.reference}</small></li>)}</ul></details></div></div>}
    {documents.length > 1 && <details className="learning-document-history"><summary>较早版本（{documents.length - 1}）</summary><ul>{documents.slice(1).map(document => <li key={document.id}><span>{document.document_title}.docx</span><time>{new Date(document.created_at).toLocaleString('zh-CN')}</time></li>)}</ul></details>}
    {notice && <p className="success-banner">{notice}</p>}{error && <p className="error-banner">{error}</p>}
  </section>
}
