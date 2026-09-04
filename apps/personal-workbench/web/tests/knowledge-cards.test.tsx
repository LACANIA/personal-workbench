// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeCardDetail, KnowledgeCardRecord, VideoKnowledgePointRecord } from '../../shared/contracts/index.ts'
import { KnowledgeCardsPanel } from '../src/components/KnowledgeCardsPanel.tsx'

const legacy: VideoKnowledgePointRecord = {
  id: 'legacy-1', video_document_id: 'document-1', segment_id: 'segment-1', title: 'Legacy IQ',
  summary: 'I 和 Q 两路正交分量携带幅度与相位信息。', keywords: ['I', 'Q'], memory_state: 'staged',
  created_at: '2026-08-24T00:00:00.000Z', citation: '[KnowledgePoint:legacy-1 VideoSegment:segment-1]',
}

const card: KnowledgeCardRecord = {
  id: 'card-1', batch_id: 'batch-1', video_document_id: 'document-1', segment_id: 'segment-1', card_index: 0,
  title: 'IQ 正交表示', concept: '正交分量', core_claim: 'I 与 Q 的相位相差九十度。',
  explanation: '正交分量共同携带幅度与相位信息。', keywords: ['I', 'Q', '正交'], relations: [],
  source_segment_ids: ['segment-1'], source_start: 34_000, source_end: 72_000, extractor_provider: 'qwen3_local',
  extractor_model: 'qwen3:8b', prompt_version: 'knowledge-extraction-v1', source_sha256: 'a'.repeat(64),
  card_sha256: 'b'.repeat(64), embedding_input_version: 'knowledge-card-embedding-v1', status: 'staged',
  validation_status: 'needs_grounding_review', grounding_issues: ['unsupported_protected_token:90'],
  duplicate_status: 'possible_duplicate', duplicate_of_card_id: 'card-0', source_state: 'current', artifact_id: 'artifact-1',
  supersedes_card_id: null, created_at: '2026-08-24T00:00:01.000Z',
  citation: '[KnowledgeCard:card-1 VideoSegment:segment-1 34000-72000ms]',
}

const detail: KnowledgeCardDetail = {
  card,
  segment: {
    id: 'segment-1', video_document_id: 'document-1', segment_index: 0, start_ms: 34_000, end_ms: 72_000,
    text: 'I分量和Q分量在相位上相差九十度。', text_hash: 'c'.repeat(64), embedding_provider: 'ollama',
    embedding_model: 'qwen3-embedding:0.6b', embedding_json: null, created_at: '2026-08-24T00:00:00.000Z',
    citation: '[VideoSegment:segment-1 34000-72000ms]',
  },
  document: {
    id: 'document-1', job_id: 'job-1', project_id: 'project-1', source_type: 'subtitle', title: 'IQ视频',
    source_ref: 'fixture.srt', source_hash: 'd'.repeat(64), transcript_source: 'user_subtitle', segment_count: 1,
    knowledge_point_count: 1, memory_state: 'staged', created_at: '2026-08-24T00:00:00.000Z', metadata: {},
  },
  artifact: {
    id: 'artifact-1', project_id: 'project-1', task_id: 'task-1', artifact_type: 'dataset', name: 'knowledge-cards.json',
    relative_path: 'output\\knowledge-cards.json', absolute_path: 'E:\\fixture\\knowledge-cards.json', mime_type: 'application/json',
    size_bytes: 100, sha256: 'e'.repeat(64), status: 'active', version_count: 1, created_at: '2026-08-24T00:00:02.000Z', metadata: {},
  },
  evidence: [{
    id: 'evidence-1', artifact_id: 'artifact-1', source_type: 'task', source_id: 'task-1', relation_type: 'generated_from',
    created_at: '2026-08-24T00:00:03.000Z', metadata: {}, source: { type: 'task', id: 'task-1', label: '提取任务', available: true, metadata: {} },
  }],
  reviews: [{ id: 'review-1', card_id: 'card-1', decision: 'needs_revision', note: '检查数字来源', created_at: '2026-08-24T00:00:04.000Z' }],
}

afterEach(cleanup)

function view(options: { mode?: 'legacy' | 'structured'; selected?: KnowledgeCardDetail | null } = {}) {
  const handlers = { onMode: vi.fn(), onExtract: vi.fn(), onOpen: vi.fn(), onReview: vi.fn(), onRegenerate: vi.fn() }
  render(<KnowledgeCardsPanel legacy={[legacy]} cards={[card]} mode={options.mode ?? 'structured'} selected={options.selected ?? null}
    busy={false} defaultMode="legacy" {...handlers} />)
  return handlers
}

describe('STEP-31 Knowledge Card UI', () => {
  it('keeps Legacy and Structured as explicit modes', () => {
    const handlers = view({ mode: 'legacy' })
    expect(screen.getByText('Legacy IQ')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Structured' }))
    expect(handlers.onMode).toHaveBeenCalledWith('structured')
  })

  it('renders structured fields, time, grounding and duplicate flags', () => {
    view()
    expect(screen.getByText('IQ 正交表示')).toBeInTheDocument()
    expect(screen.getByText('I 与 Q 的相位相差九十度。')).toBeInTheDocument()
    expect(screen.getByText('00:34 – 01:12')).toBeInTheDocument()
    expect(screen.getByText('来源复核')).toBeInTheDocument()
    expect(screen.getByText('可能重复')).toBeInTheDocument()
  })

  it('opens a selected card without expanding the transcript by default', () => {
    const handlers = view()
    fireEvent.click(screen.getByRole('button', { name: '查看原文与证据' }))
    expect(handlers.onOpen).toHaveBeenCalledWith('card-1')
    expect(screen.queryByText('I分量和Q分量在相位上相差九十度。')).not.toBeInTheDocument()
  })

  it('shows source, model, prompt, Artifact and Evidence in detail', () => {
    view({ selected: detail })
    expect(screen.getByText('I分量和Q分量在相位上相差九十度。')).toBeInTheDocument()
    expect(screen.getByText('qwen3:8b')).toBeInTheDocument()
    expect(screen.getByText('knowledge-extraction-v1')).toBeInTheDocument()
    expect(screen.getByText(/Artifact：knowledge-cards\.json/u)).toBeInTheDocument()
    expect(screen.getByText('task:task-1')).toBeInTheDocument()
  })

  it('exposes manual review and non-destructive regeneration actions', () => {
    const handlers = view({ selected: detail })
    fireEvent.click(screen.getByRole('button', { name: 'Approved' }))
    fireEvent.click(screen.getByRole('button', { name: 'Needs Revision' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rejected' }))
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate Card' }))
    expect(handlers.onReview).toHaveBeenCalledTimes(3)
    expect(handlers.onRegenerate).toHaveBeenCalledWith('card-1')
  })
})
