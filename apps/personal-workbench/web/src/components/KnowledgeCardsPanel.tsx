import type {
  KnowledgeCardDetail,
  KnowledgeCardRecord,
  KnowledgeCardReviewDecision,
  VideoKnowledgePointRecord,
} from '../../../shared/contracts/index.ts'
import { Badge, Panel } from './common.tsx'

function time(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

function validationTone(card: KnowledgeCardRecord): 'green' | 'amber' | 'red' | 'blue' {
  if (card.source_state === 'outdated') return 'red'
  if (card.validation_status === 'needs_grounding_review' || card.duplicate_status !== 'unique') return 'amber'
  return card.status === 'approved' ? 'green' : 'blue'
}

export function KnowledgeCardsPanel({
  legacy,
  cards,
  mode,
  selected,
  busy,
  defaultMode,
  onMode,
  onExtract,
  onOpen,
  onReview,
  onRegenerate,
}: {
  legacy: VideoKnowledgePointRecord[]
  cards: KnowledgeCardRecord[]
  mode: 'legacy' | 'structured'
  selected: KnowledgeCardDetail | null
  busy: boolean
  defaultMode: 'legacy' | 'structured'
  onMode(value: 'legacy' | 'structured'): void
  onExtract(): void
  onOpen(id: string): void
  onReview(id: string, decision: KnowledgeCardReviewDecision): void
  onRegenerate(id: string): void
}): JSX.Element {
  return <div className="knowledge-card-stack">
    <Panel title="Knowledge Cards" subtitle={`Legacy 完整保留；固定 A/B 当前默认展示为 ${defaultMode === 'structured' ? 'Structured' : 'Legacy'}。`}>
      <div className="knowledge-mode-toolbar">
        <div role="tablist" aria-label="知识表示模式">
          <button className={mode === 'legacy' ? 'active' : ''} onClick={() => onMode('legacy')}>Legacy</button>
          <button className={mode === 'structured' ? 'active' : ''} onClick={() => onMode('structured')}>Structured</button>
        </div>
        <button className="primary" disabled={busy} onClick={onExtract}>{cards.length === 0 ? '生成结构化知识卡' : '生成新批次'}</button>
      </div>
      {mode === 'legacy' ? <div className="video-points knowledge-legacy-list">
        {legacy.map(point => <article key={point.id}>
          <header><strong>{point.title}</strong><Badge tone={point.memory_state === 'published' ? 'green' : 'amber'}>{point.memory_state}</Badge></header>
          <p>{point.summary}</p><code>{point.citation}</code>
        </article>)}
      </div> : cards.length === 0 ? <div className="empty-state"><strong>尚无 Structured Knowledge Card</strong><p>点击“生成结构化知识卡”，系统会使用已有 Segment，不会重新运行 ASR。</p></div> : <div className="knowledge-card-grid">
        {cards.map(card => <article key={card.id} className={selected?.card.id === card.id ? 'selected' : ''}>
          <header><div><strong>{card.title}</strong><small>{card.concept}</small></div><Badge tone={validationTone(card)}>{card.status}</Badge></header>
          <h4>核心结论</h4><p>{card.core_claim}</p>
          <h4>解释</h4><p>{card.explanation}</p>
          <div className="knowledge-keywords">{card.keywords.map(keyword => <span key={keyword}>{keyword}</span>)}</div>
          <div className="knowledge-card-flags">
            <span>{time(card.source_start)} – {time(card.source_end)}</span>
            {card.validation_status === 'needs_grounding_review' && <Badge tone="amber">来源复核</Badge>}
            {card.duplicate_status !== 'unique' && <Badge tone="amber">可能重复</Badge>}
            {card.source_state === 'outdated' && <Badge tone="red">来源已变化</Badge>}
          </div>
          <code>{card.citation}</code>
          <button type="button" onClick={() => onOpen(card.id)}>查看原文与证据</button>
        </article>)}
      </div>}
    </Panel>
    {selected !== null && <Panel title="Knowledge Card 详情" subtitle="结构化文本由本机 qwen3:8b 生成，Evidence 指向原始 Video Segment。">
      <div className="knowledge-detail-grid">
        <section><span>标题</span><strong>{selected.card.title}</strong></section>
        <section><span>概念</span><strong>{selected.card.concept}</strong></section>
        <section><span>时间范围</span><strong>{time(selected.card.source_start)} – {time(selected.card.source_end)}</strong></section>
        <section><span>审核状态</span><strong>{selected.card.status}</strong></section>
        <section><span>提取模型</span><strong>{selected.card.extractor_model}</strong></section>
        <section><span>Prompt</span><strong>{selected.card.prompt_version}</strong></section>
      </div>
      <div className="knowledge-source-comparison">
        <article><h3>Structured Card</h3><p><strong>{selected.card.core_claim}</strong></p><p>{selected.card.explanation}</p><code>{selected.card.citation}</code></article>
        <article><h3>Source Segment</h3><time>{time(selected.segment.start_ms)} – {time(selected.segment.end_ms)}</time><p>{selected.segment.text}</p><code>[VideoSegment:{selected.segment.id} {selected.segment.start_ms}-{selected.segment.end_ms}ms]</code></article>
      </div>
      <div className="knowledge-detail-evidence">
        <h3>Artifact 与 Evidence</h3>
        <p>Artifact：{selected.artifact?.name ?? '尚未关联'}</p>
        {selected.evidence.length === 0 ? <p>当前没有 Evidence 关系。</p> : <ul>{selected.evidence.map(item => <li key={item.id}><code>{item.source_type}:{item.source_id}</code><span>{item.relation_type}</span></li>)}</ul>}
        {selected.card.grounding_issues.length > 0 && <details><summary>Grounding Issues</summary><ul>{selected.card.grounding_issues.map(issue => <li key={issue}><code>{issue}</code></li>)}</ul></details>}
      </div>
      <div className="knowledge-review-actions">
        <button disabled={busy} onClick={() => onReview(selected.card.id, 'approved')}>Approved</button>
        <button disabled={busy} onClick={() => onReview(selected.card.id, 'needs_revision')}>Needs Revision</button>
        <button disabled={busy} onClick={() => onReview(selected.card.id, 'rejected')}>Rejected</button>
        <button disabled={busy} onClick={() => onRegenerate(selected.card.id)}>Regenerate Card</button>
      </div>
      {selected.reviews.length > 0 && <div className="knowledge-review-history"><h3>审核记录</h3>{selected.reviews.map(review => <article key={review.id}><strong>{review.decision}</strong><span>{new Date(review.created_at).toLocaleString('zh-CN')}</span><p>{review.note || '未填写备注'}</p></article>)}</div>}
    </Panel>}
  </div>
}
