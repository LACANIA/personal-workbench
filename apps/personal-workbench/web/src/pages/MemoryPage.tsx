import { useState } from 'react'
import type { DatabaseRole } from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import type { AppSnapshot } from '../app/types.ts'
import { Badge, EmptyState, Metric, Panel } from '../components/common.tsx'

export function MemoryPage({ snapshot, databaseRole }: { snapshot: AppSnapshot; databaseRole: DatabaseRole }): JSX.Element {
  const [query, setQuery] = useState('GNN localization comparison')
  const [project, setProject] = useState(databaseRole === 'test' ? 'STAKG-SP' : '')
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [chunk, setChunk] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const status = snapshot.memory
  const counts = (status?.counts ?? {}) as Record<string, number>
  const search = async () => {
    setBusy(true); setError(''); setChunk(null)
    try {
      const bridge = await api.searchChunks({ databaseRole, query, ...(project ? { project_name: project } : {}), version_scope: 'latest', limit: 5, max_total_chars: 4000 })
      setResult(((bridge.result as Record<string, unknown> | undefined) ?? bridge))
    } catch (caught) { setError(String(caught)) }
    finally { setBusy(false) }
  }
  const openChunk = async (uid: string) => {
    try {
      const bridge = await api.getChunk({ databaseRole, chunk_uid: uid, include_content: true })
      setChunk(((bridge.result as Record<string, unknown> | undefined) ?? bridge))
    } catch (caught) { setError(String(caught)) }
  }
  const results = (result?.results ?? []) as Record<string, unknown>[]
  return <div className="page-stack">
    <header className="page-heading"><div><Badge tone="blue">记忆与证据</Badge><h1>从结构化记录定位到原始文档分块</h1><p>普通模式读取正式数据库；开发模式可以查看测试资料。所有页面操作均为只读查询。</p></div><Badge tone={databaseRole === 'test' ? 'amber' : 'green'}>{databaseRole === 'test' ? '测试数据' : '正式数据'}</Badge></header>
    <div className="metric-grid"><Metric label="Schema" value={`v${String(status?.userVersion ?? '—')}`} /><Metric label="Project" value={String(counts.projects ?? 0)} /><Metric label="Document" value={String(counts.documents ?? 0)} /><Metric label="Chunk / FTS" value={`${String(counts.document_chunks ?? 0)} / ${String(status?.ftsCount ?? 0)}`} /></div>
    <Panel title="Document Chunk 检索" subtitle="先返回短片段，再使用真实 Chunk UID 精确读取。">
      <div className="search-controls"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="输入文档内容关键词" /><input value={project} onChange={event => setProject(event.target.value)} placeholder="项目筛选（可选）" /><select defaultValue="latest"><option value="latest">最新版本</option><option value="all">全部版本</option><option value="specific">指定版本</option></select><button className="primary" disabled={busy || query.trim().length === 0} onClick={() => void search()}>{busy ? '正在搜索…' : '搜索'}</button></div>
      {error && <p className="error-banner">{error}</p>}
      {result && <div className="search-meta"><Badge tone={results.length > 0 ? 'green' : 'neutral'}>{String(result.search_backend ?? 'unknown')}</Badge><span>{String(result.returned_count ?? results.length)} 条结果 · version_scope={String(result.version_scope ?? 'latest')}</span></div>}
      {result && results.length === 0 && <EmptyState icon="⌕" title="当前Document Chunk索引没有匹配内容。" detail="可以缩小项目范围或调整查询关键词。" />}
      <div className="chunk-results">{results.map(item => <article key={String(item.chunk_uid)}><header><div><Badge tone="blue">Version {String(item.document_version_id)}</Badge><strong>{String(item.title)}</strong></div><span>{String(item.chunk_start_line)}–{String(item.chunk_end_line)} 行</span></header><code>{String(item.canonical_path)}</code><p>{String(item.snippet)}</p><div className="citation-box"><code>{String(item.chunk_citation)}</code><button onClick={() => void navigator.clipboard.writeText(String(item.chunk_citation))}>复制引用</button></div><button className="text-button" onClick={() => void openChunk(String(item.chunk_uid))}>精确读取该 Chunk →</button></article>)}</div>
      {chunk && <div className="chunk-drawer"><header><div><Badge tone="green">精确 Chunk</Badge><strong>{String(chunk.chunk_uid)}</strong></div><button onClick={() => setChunk(null)}>关闭</button></header><div className="chunk-facts"><span>Version {String(chunk.document_version_id)}</span><span>Source {String(chunk.source_id)}</span><span>{String(chunk.start_line)}–{String(chunk.end_line)} 行</span></div><pre>{String(chunk.content)}</pre><code>{String(chunk.chunk_citation)}</code></div>}
    </Panel>
    <Panel title="结构化实体" subtitle="当前数据库的只读统计"><div className="entity-grid">{Object.entries(counts).map(([name, count]) => <div key={name}><span>{name}</span><strong>{count}</strong></div>)}</div></Panel>
  </div>
}
