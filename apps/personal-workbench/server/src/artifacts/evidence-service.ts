import { randomUUID } from 'node:crypto'
import {
  ARTIFACT_EVIDENCE_RELATION_TYPES,
  ARTIFACT_EVIDENCE_SOURCE_TYPES,
  type ArtifactEvidenceBundle,
  type ArtifactEvidenceCreateInput,
  type ArtifactEvidenceLinkRecord,
  type ArtifactEvidenceRelationType,
  type ArtifactEvidenceSourceSummary,
  type ArtifactEvidenceSourceType,
  type ArtifactEvidenceView,
  type ArtifactRecord,
  type ArtifactRegisterInput,
  type DatabaseRole,
  type MemoryEntityType,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { readDocumentChunkIdentity, readMemoryEntity, readMemorySource } from '../memory/service.ts'

const MEMORY_TYPES: MemoryEntityType[] = ['project', 'decision', 'experiment', 'document', 'task', 'session']
const CHUNK_UID = /^[0-9a-f]{64}$/u

function requiredText(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string') throw new Error(`INVALID_EVIDENCE_${field.toUpperCase()}`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum || normalized.includes('\0')) {
    throw new Error(`INVALID_EVIDENCE_${field.toUpperCase()}`)
  }
  return normalized
}

function sourceType(value: unknown): ArtifactEvidenceSourceType {
  if (typeof value !== 'string' || !ARTIFACT_EVIDENCE_SOURCE_TYPES.includes(value as ArtifactEvidenceSourceType)) {
    throw new Error('INVALID_EVIDENCE_SOURCE_TYPE')
  }
  return value as ArtifactEvidenceSourceType
}

function relationType(value: unknown): ArtifactEvidenceRelationType {
  if (typeof value !== 'string' || !ARTIFACT_EVIDENCE_RELATION_TYPES.includes(value as ArtifactEvidenceRelationType)) {
    throw new Error('INVALID_EVIDENCE_RELATION_TYPE')
  }
  return value as ArtifactEvidenceRelationType
}

function databaseRole(value: unknown): DatabaseRole {
  if (value === undefined) return 'production'
  if (value !== 'production' && value !== 'test') throw new Error('INVALID_EVIDENCE_DATABASE_ROLE')
  return value
}

function memoryType(value: unknown): MemoryEntityType {
  if (typeof value !== 'string' || !MEMORY_TYPES.includes(value as MemoryEntityType)) throw new Error('INVALID_EVIDENCE_MEMORY_TYPE')
  return value as MemoryEntityType
}

interface ResolvedEvidenceSource {
  canonicalId: string
  metadata: Record<string, unknown>
  summary: ArtifactEvidenceSourceSummary
}

export class ArtifactEvidenceService {
  constructor(readonly database: WorkbenchDatabase) {}

  create(artifactId: string, input: ArtifactEvidenceCreateInput): ArtifactEvidenceView {
    const artifact = this.requireArtifact(artifactId)
    if (input === null || typeof input !== 'object') throw new Error('INVALID_EVIDENCE_INPUT')
    const type = sourceType(input.source_type)
    const relation = relationType(input.relation_type)
    const resolved = this.resolveForCreate(artifact, type, input)
    const record = this.database.createArtifactEvidenceLink({
      id: randomUUID(),
      artifact_id: artifact.id,
      source_type: type,
      source_id: resolved.canonicalId,
      relation_type: relation,
      created_at: new Date().toISOString(),
      metadata: resolved.metadata,
    })
    return { ...record, source: resolved.summary }
  }

  linkRegistration(artifact: ArtifactRecord, input: ArtifactRegisterInput): ArtifactEvidenceView[] {
    const linked: ArtifactEvidenceView[] = []
    if (artifact.task_id !== null && input.auto_link_task !== false) {
      linked.push(this.create(artifact.id, {
        source_type: 'task',
        source_id: artifact.task_id,
        relation_type: 'generated_from',
      }))
      const task = this.database.getTask(artifact.task_id)
      if (input.auto_link_session !== false && task?.harnessSessionId !== null && task?.harnessSessionId !== undefined) {
        linked.push(this.create(artifact.id, {
          source_type: 'session',
          source_id: task.harnessSessionId,
          relation_type: 'created_by',
        }))
      }
    }
    for (const selected of input.evidence ?? []) linked.push(this.create(artifact.id, selected))
    return linked
  }

  forArtifact(artifactId: string): ArtifactEvidenceBundle {
    const artifact = this.requireArtifact(artifactId)
    const evidence = this.database.listArtifactEvidenceLinks(artifact.id).map(link => this.view(link))
    return { artifact, evidence, count: evidence.length }
  }

  bySource(typeValue: string, sourceIdValue: string): ArtifactEvidenceView[] {
    const type = sourceType(typeValue)
    const id = requiredText(sourceIdValue, 'source_id')
    return this.database.listEvidenceLinksBySource(type, id).map(link => this.view(link))
  }

  delete(idValue: string): ArtifactEvidenceLinkRecord {
    const id = requiredText(idValue, 'id', 128)
    const existing = this.database.getArtifactEvidenceLink(id)
    if (existing === undefined) throw new Error('EVIDENCE_LINK_NOT_FOUND')
    this.database.deleteArtifactEvidenceLink(id)
    return existing
  }

  private requireArtifact(idValue: string): ArtifactRecord {
    const id = requiredText(idValue, 'artifact_id', 128)
    const artifact = this.database.getArtifact(id)
    if (artifact === undefined) throw new Error('ARTIFACT_NOT_FOUND')
    return artifact
  }

  private resolveForCreate(
    artifact: ArtifactRecord,
    type: ArtifactEvidenceSourceType,
    input: ArtifactEvidenceCreateInput,
  ): ResolvedEvidenceSource {
    const rawId = requiredText(input.source_id, 'source_id')
    if (type === 'task') {
      const task = this.database.getTask(rawId)
      if (task === undefined) throw new Error('EVIDENCE_SOURCE_NOT_FOUND')
      if (task.projectId !== artifact.project_id) throw new Error('EVIDENCE_PROJECT_DENIED')
      return { canonicalId: task.id, metadata: {}, summary: { type, id: task.id, label: task.title, available: true, metadata: { status: task.status } } }
    }
    if (type === 'session') {
      const task = this.database.getTaskByHarnessSessionId(rawId)
      if (task === undefined) throw new Error('EVIDENCE_SOURCE_NOT_FOUND')
      if (task.projectId !== artifact.project_id) throw new Error('EVIDENCE_PROJECT_DENIED')
      return { canonicalId: rawId, metadata: {}, summary: { type, id: rawId, label: `Session ${rawId}`, available: true, metadata: { task_id: task.id } } }
    }
    if (type === 'artifact') {
      const sourceArtifact = this.database.getArtifact(rawId)
      if (sourceArtifact === undefined) throw new Error('EVIDENCE_SOURCE_NOT_FOUND')
      if (sourceArtifact.project_id !== artifact.project_id) throw new Error('EVIDENCE_PROJECT_DENIED')
      if (sourceArtifact.id === artifact.id) throw new Error('EVIDENCE_SELF_LINK_DENIED')
      return { canonicalId: sourceArtifact.id, metadata: {}, summary: { type, id: sourceArtifact.id, label: sourceArtifact.name, available: true, metadata: { artifact_type: sourceArtifact.artifact_type } } }
    }
    const role = databaseRole(input.database_role)
    if (type === 'memory') {
      const parsed = rawId.includes(':') ? rawId.split(':', 2) : null
      const entityType = memoryType(input.memory_type ?? parsed?.[0])
      const memoryId = requiredText(parsed?.[1] ?? rawId, 'memory_id', 128)
      const record = readMemoryEntity(role, entityType, memoryId)
      if (record === undefined) throw new Error('EVIDENCE_SOURCE_NOT_FOUND')
      const canonicalId = `${entityType}:${memoryId}`
      return {
        canonicalId,
        metadata: { database_role: role, memory_type: entityType, memory_id: memoryId },
        summary: {
          type,
          id: canonicalId,
          label: `${entityType} #${memoryId} · ${String(record.label)}`,
          available: true,
          metadata: { database_role: role, memory_type: entityType, memory_id: memoryId, project_name: record.project_name },
        },
      }
    }
    if (type === 'document_chunk') {
      const chunkUid = rawId.toLowerCase()
      if (!CHUNK_UID.test(chunkUid)) throw new Error('INVALID_EVIDENCE_CHUNK_UID')
      const chunk = readDocumentChunkIdentity(role, chunkUid)
      if (chunk === undefined) throw new Error('EVIDENCE_SOURCE_NOT_FOUND')
      return {
        canonicalId: chunkUid,
        metadata: {
          database_role: role,
          chunk_id: chunk.chunk_id,
          document_id: chunk.document_id,
          version_id: chunk.document_version_id,
        },
        summary: {
          type,
          id: chunkUid,
          label: `${String(chunk.title || chunk.canonical_path)} · ${String(chunk.start_line)}-${String(chunk.end_line)}`,
          available: true,
          metadata: {
            database_role: role,
            chunk_id: chunk.chunk_id,
            document_id: chunk.document_id,
            version_id: chunk.document_version_id,
            canonical_path: chunk.canonical_path,
            project_name: chunk.project_name,
          },
        },
      }
    }
    const source = readMemorySource(role, rawId)
    if (source === undefined) throw new Error('EVIDENCE_SOURCE_NOT_FOUND')
    return {
      canonicalId: rawId,
      metadata: { database_role: role, source_id: rawId },
      summary: {
        type,
        id: rawId,
        label: String(source.label),
        available: true,
        metadata: { database_role: role, source_type: source.source_type, project_name: source.project_name },
      },
    }
  }

  private view(link: ArtifactEvidenceLinkRecord): ArtifactEvidenceView {
    const artifact = this.requireArtifact(link.artifact_id)
    try {
      return {
        ...link,
        source: this.resolvePersisted(artifact, link),
      }
    } catch (error) {
      const unavailable = error instanceof Error ? error.message : String(error)
      return {
        ...link,
        source: {
          type: link.source_type,
          id: link.source_id,
          label: `${link.source_type}:${link.source_id}`,
          available: false,
          metadata: { available: false, error: unavailable },
        },
      }
    }
  }

  private resolvePersisted(artifact: ArtifactRecord, link: ArtifactEvidenceLinkRecord): ArtifactEvidenceSourceSummary {
    if (link.source_type === 'memory') {
      const role = databaseRole(link.metadata.database_role)
      const entityType = memoryType(link.metadata.memory_type)
      const memoryId = requiredText(link.metadata.memory_id, 'memory_id', 128)
      return this.resolveForCreate(artifact, link.source_type, {
        source_type: link.source_type,
        source_id: memoryId,
        relation_type: link.relation_type,
        database_role: role,
        memory_type: entityType,
      }).summary
    }
    if (link.source_type === 'document_chunk' || link.source_type === 'source') {
      return this.resolveForCreate(artifact, link.source_type, {
        source_type: link.source_type,
        source_id: link.source_id,
        relation_type: link.relation_type,
        database_role: databaseRole(link.metadata.database_role),
      }).summary
    }
    return this.resolveForCreate(artifact, link.source_type, {
      source_type: link.source_type,
      source_id: link.source_id,
      relation_type: link.relation_type,
    }).summary
  }
}
