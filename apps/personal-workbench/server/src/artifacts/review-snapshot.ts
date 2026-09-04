import { createHash } from 'node:crypto'
import type { ArtifactEvidenceBundle, ReviewEvidenceSnapshotItem } from '../../../shared/contracts/index.ts'

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonical(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

export function reviewEvidenceSnapshot(bundle: ArtifactEvidenceBundle): ReviewEvidenceSnapshotItem[] {
  return bundle.evidence.map(link => ({
    key: `${link.source_type}:${link.source_id}:${link.relation_type}`,
    evidence_id: link.id,
    source_type: link.source_type,
    source_id: link.source_id,
    relation_type: link.relation_type,
    available: link.source.available,
    label: link.source.label,
    metadata: canonical(link.metadata) as Record<string, unknown>,
    source_metadata: canonical(link.source.metadata) as Record<string, unknown>,
  })).sort((left, right) => left.evidence_id.localeCompare(right.evidence_id))
}

export function reviewEvidenceHash(snapshot: ReviewEvidenceSnapshotItem[]): string {
  const signature = snapshot.map(item => ({
    id: item.evidence_id,
    source_type: item.source_type,
    source_id: item.source_id,
    relation_type: item.relation_type,
    available: item.available,
    metadata: canonical(item.metadata),
    source_metadata: canonical(item.source_metadata),
  })).sort((left, right) => left.id.localeCompare(right.id))
  return createHash('sha256').update(JSON.stringify(signature), 'utf8').digest('hex')
}
