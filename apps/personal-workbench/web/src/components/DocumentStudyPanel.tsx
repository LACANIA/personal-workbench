import { useEffect, useState } from 'react'
import type { UnifiedDocumentRecord } from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import { Badge, EmptyState } from './common.tsx'

type Answer = { answer: string; citations: Array<{ title: string; section: string; source_anchor: string; text: string; score: number }> }

function friendlyAnchor(anchor: string): string {
  return anchor.replace(/^page:/u, '第 ').replace(/^slide:/u, '第 ').replace(/^sheet:/u, '工作表：')
}

export function DocumentStudyPanel({ taskId, advancedMode }: { taskId: string; advancedMode: boolean }): JSX.Element | null {
  const [document, setDocument] = useState<UnifiedDocumentRecord | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    // Older UI test doubles and older local service tabs do not expose this
    // optional detail endpoint. Treat an incomplete response as unavailable.
    if (typeof api.documentForTask !== 'function') return () => { disposed = true }
    void api.documentForTask(taskId).then(value => {
      if (!disposed && Array.isArray(value?.sections)) setDocument(value)
    }).catch(() => { if (!disposed) setDocument(null) })
    return () => { disposed = true }
  }, [taskId])

  if (document === null) return null
  const ask = async () => {
    if (question.trim().length === 0) return
    setBusy(true); setError(''); setAnswer(null)
    try { setAnswer(await api.askDocument({ document_id: document.id, query: question.trim(), top_k: 5 })) }
    catch { setError('暂时无法回答这个问题，请稍后重试。') }
    finally { setBusy(false) }
  }
  const sections = Array.isArray(document.sections) ? document.sections : []
  return <section className="document-study-panel">
    <header><div><Badge tone="blue">资料</Badge><h3>问这份资料</h3><p>回答只依据已经读取的资料内容，并附上对应章节或页码。</p></div></header>
    <div className="document-question-row"><input aria-label="输入关于这份资料的问题" value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void ask() }} placeholder="输入关于这份资料的问题…" /><button className="primary" disabled={busy || question.trim().length === 0} onClick={() => void ask()}>{busy ? '正在查找…' : '提问'}</button></div>
    {answer && <article className="document-answer"><strong>回答</strong><p>{answer.answer}</p><div><strong>来源</strong>{answer.citations.map((citation, index) => <details key={`${citation.source_anchor}-${index}`}><summary>{citation.section || document.title} · {friendlyAnchor(citation.source_anchor)}</summary><p>{citation.text}</p></details>)}</div></article>}
    {error && <p className="error-banner">{error}</p>}
    <details className="document-structure" open><summary>资料结构</summary><ul>{sections.map((section, index) => <li key={`${section.source_anchor}-${index}`}><strong>{section.heading || `资料部分 ${index + 1}`}</strong><span>{friendlyAnchor(section.source_anchor)}</span></li>)}</ul></details>
    {advancedMode && <details className="document-advanced"><summary>Chunks / Sections</summary><p>当前资料含 {sections.length} 个已解析部分；高级详情保留来源锚点，已完成片段可在继续处理时复用。</p><ul>{sections.map((section, index) => <li key={`${section.source_anchor}-${index}`}><code>{section.source_anchor}</code><span>{section.text.length} 字符</span></li>)}</ul></details>}
  </section>
}
