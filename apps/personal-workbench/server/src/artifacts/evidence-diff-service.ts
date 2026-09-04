import type {
  EvidenceDiffEntry,
  EvidenceDiffReport,
  ReviewEvidenceSnapshotItem,
  ReviewSnapshotDetail,
} from '../../../shared/contracts/index.ts'
import { ArtifactEvidenceService } from './evidence-service.ts'
import { canonical, reviewEvidenceHash, reviewEvidenceSnapshot } from './review-snapshot.ts'

function comparable(item: ReviewEvidenceSnapshotItem): string {
  return JSON.stringify(canonical({ metadata: item.metadata, source_metadata: item.source_metadata }))
}

function entry(previous: ReviewEvidenceSnapshotItem | null, current: ReviewEvidenceSnapshotItem | null): EvidenceDiffEntry {
  const selected = current ?? previous!
  return {
    key: selected.key,
    source_type: selected.source_type,
    source_id: selected.source_id,
    relation_type: selected.relation_type,
    previous,
    current,
  }
}

export class EvidenceDiffService {
  constructor(readonly evidence: ArtifactEvidenceService) {}

  snapshot(artifactId: string): ReviewEvidenceSnapshotItem[] {
    return reviewEvidenceSnapshot(this.evidence.forArtifact(artifactId))
  }

  diff(artifactId: string, detail: ReviewSnapshotDetail | undefined, oldHash: string | null): EvidenceDiffReport {
    const current = this.snapshot(artifactId)
    const newHash = reviewEvidenceHash(current)
    if (detail === undefined) {
      return {
        snapshot_available: false,
        old_hash: oldHash,
        new_hash: newHash,
        changed: oldHash !== null && oldHash !== newHash,
        added: [], removed: [], invalidated: [], restored: [], metadata_changed: [], summary_changed: [],
        note: oldHash !== null && oldHash !== newHash ? '旧审核没有 Evidence 关系快照，仅能确认关系签名已经变化。' : 'Evidence 签名没有变化。',
      }
    }
    const previousByKey = new Map(detail.evidence_snapshot.map(item => [item.key, item]))
    const currentByKey = new Map(current.map(item => [item.key, item]))
    const added: EvidenceDiffEntry[] = []
    const removed: EvidenceDiffEntry[] = []
    const invalidated: EvidenceDiffEntry[] = []
    const restored: EvidenceDiffEntry[] = []
    const metadataChanged: EvidenceDiffEntry[] = []
    const summaryChanged: EvidenceDiffEntry[] = []
    for (const [key, item] of currentByKey) {
      const previous = previousByKey.get(key)
      if (previous === undefined) { added.push(entry(null, item)); continue }
      if (previous.available && !item.available) invalidated.push(entry(previous, item))
      if (!previous.available && item.available) restored.push(entry(previous, item))
      if (comparable(previous) !== comparable(item)) metadataChanged.push(entry(previous, item))
      if (previous.label !== item.label) summaryChanged.push(entry(previous, item))
    }
    for (const [key, item] of previousByKey) if (!currentByKey.has(key)) removed.push(entry(item, null))
    const changed = oldHash !== null && oldHash !== newHash
    return {
      snapshot_available: true,
      old_hash: oldHash,
      new_hash: newHash,
      changed,
      added,
      removed,
      invalidated,
      restored,
      metadata_changed: metadataChanged,
      summary_changed: summaryChanged,
      note: changed ? 'Evidence 差异来自审核时关系快照与当前可解析状态。' : 'Evidence 关系和元数据没有变化。',
    }
  }
}
