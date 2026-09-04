import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  ArtifactDiffLine,
  ArtifactDiffReport,
  ArtifactRecord,
  ReviewArtifactSnapshotKind,
  ReviewSnapshotDetail,
} from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { WorkbenchDatabase } from '../database.ts'
import { ArtifactService, artifactBelongsToRoot } from './service.ts'

const MAX_SNAPSHOT_BYTES = 1024 * 1024
const MAX_DIFF_LINES = 200
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])
const CODE_EXTENSIONS = new Set(['.py', '.ts', '.tsx', '.js', '.mjs', '.cpp', '.cc', '.c', '.h', '.hpp', '.java'])
const DATASET_EXTENSIONS = new Set(['.csv', '.json', '.txt'])

function sha256(buffer: Buffer): string { return createHash('sha256').update(buffer).digest('hex') }

function snapshotKind(filePath: string): ReviewArtifactSnapshotKind | null {
  const extension = path.extname(filePath).toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (DATASET_EXTENSIONS.has(extension)) return 'dataset'
  return null
}

function pathKey(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function safeSnapshotPath(relativePath: string, snapshotRoot: string): string {
  const candidate = path.resolve(path.dirname(snapshotRoot), relativePath)
  const root = pathKey(snapshotRoot)
  const key = pathKey(candidate)
  if (!(key === root || key.startsWith(`${root}${path.sep}`))) throw new Error('REVIEW_SNAPSHOT_PATH_DENIED')
  return candidate
}

function decodeText(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error('REVIEW_SNAPSHOT_BINARY_DENIED')
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/u, '')
}

function lineRange(start: number, end: number): string | null {
  if (start > end) return null
  return start === end ? String(start) : `${start}-${end}`
}

function impact(changedLines: number): ArtifactDiffReport['impact_scope'] {
  if (changedLines === 0) return 'none'
  if (changedLines <= 10) return 'small'
  if (changedLines <= 100) return 'medium'
  return 'large'
}

function boundedLineDiff(oldText: string, newText: string): Pick<ArtifactDiffReport,
  'added_lines' | 'removed_lines' | 'changed_blocks' | 'affected_old_range' | 'affected_new_range' | 'changes' | 'truncated' | 'impact_scope'> {
  const oldLines = oldText.replace(/\r\n?/gu, '\n').split('\n')
  const newLines = newText.replace(/\r\n?/gu, '\n').split('\n')
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix)
  const newChanged = newLines.slice(prefix, newLines.length - suffix)
  const rows: ArtifactDiffLine[] = []
  const contextStart = Math.max(0, prefix - 2)
  for (let index = contextStart; index < prefix; index += 1) rows.push({ kind: 'context', old_line: index + 1, new_line: index + 1, content: oldLines[index]! })
  oldChanged.forEach((content, index) => rows.push({ kind: 'removed', old_line: prefix + index + 1, new_line: null, content }))
  newChanged.forEach((content, index) => rows.push({ kind: 'added', old_line: null, new_line: prefix + index + 1, content }))
  for (let index = 0; index < Math.min(2, suffix); index += 1) {
    rows.push({
      kind: 'context',
      old_line: oldLines.length - suffix + index + 1,
      new_line: newLines.length - suffix + index + 1,
      content: oldLines[oldLines.length - suffix + index]!,
    })
  }
  const changedLines = oldChanged.length + newChanged.length
  return {
    added_lines: newChanged.length,
    removed_lines: oldChanged.length,
    changed_blocks: changedLines === 0 ? 0 : 1,
    affected_old_range: lineRange(prefix + 1, prefix + oldChanged.length),
    affected_new_range: lineRange(prefix + 1, prefix + newChanged.length),
    changes: rows.slice(0, MAX_DIFF_LINES),
    truncated: rows.length > MAX_DIFF_LINES,
    impact_scope: impact(changedLines),
  }
}

export interface ObservedArtifactRevision {
  sha256: string
  size_bytes: number
  canonical_path: string
  kind: ReviewArtifactSnapshotKind | null
  text: string | null
}

export class ArtifactDiffService {
  constructor(readonly database: WorkbenchDatabase, readonly artifacts: ArtifactService) {}

  private snapshotRoot(): string { return path.join(path.dirname(this.database.databasePath), 'review-snapshots') }

  observe(artifactId: string): ObservedArtifactRevision {
    const artifact = this.artifacts.get(artifactId)
    const project = this.database.getProjectContext(artifact.project_id)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const canonical = realpathSync(artifact.absolute_path)
    if (!artifactBelongsToRoot(canonical, project.rootPath) || !artifactBelongsToRoot(canonical, PATHS.labRoot)) {
      throw new Error('ARTIFACT_PROJECT_PATH_DENIED')
    }
    const information = statSync(canonical)
    if (!information.isFile()) throw new Error('ARTIFACT_FILE_NOT_FOUND')
    const bytes = readFileSync(canonical)
    const kind = snapshotKind(canonical)
    const text = kind !== null && bytes.length <= MAX_SNAPSHOT_BYTES ? decodeText(bytes) : null
    return { sha256: sha256(bytes), size_bytes: bytes.length, canonical_path: canonical, kind, text }
  }

  capture(reviewDecisionId: string, artifactId: string): Omit<ReviewSnapshotDetail, 'evidence_snapshot' | 'created_at'> {
    const observed = this.observe(artifactId)
    if (observed.kind === null || observed.text === null) {
      return {
        review_decision_id: reviewDecisionId,
        artifact_snapshot_path: null,
        artifact_snapshot_sha256: null,
        artifact_snapshot_size: null,
        artifact_snapshot_kind: observed.kind,
      }
    }
    const snapshotRoot = this.snapshotRoot()
    mkdirSync(snapshotRoot, { recursive: true })
    const absolute = path.join(snapshotRoot, `${reviewDecisionId}.snapshot`)
    const snapshotBytes = Buffer.from(observed.text, 'utf8')
    writeFileSync(absolute, snapshotBytes, { flag: 'wx', mode: 0o600 })
    return {
      review_decision_id: reviewDecisionId,
      artifact_snapshot_path: path.relative(path.dirname(this.database.databasePath), absolute),
      artifact_snapshot_sha256: sha256(snapshotBytes),
      artifact_snapshot_size: snapshotBytes.length,
      artifact_snapshot_kind: observed.kind,
    }
  }

  diff(artifactId: string, detail: ReviewSnapshotDetail | undefined, oldHash: string | null): ArtifactDiffReport {
    const artifact = this.artifacts.get(artifactId)
    let observed: ObservedArtifactRevision
    try { observed = this.observe(artifact.id) } catch {
      const current = typeof artifact.metadata.current_hash === 'string' ? artifact.metadata.current_hash : artifact.sha256
      return {
        artifact_id: artifact.id,
        artifact_name: artifact.name,
        supported: false,
        snapshot_available: detail?.artifact_snapshot_path !== null && detail?.artifact_snapshot_path !== undefined,
        snapshot_kind: detail?.artifact_snapshot_kind ?? null,
        old_hash: oldHash,
        new_hash: current,
        changed: oldHash !== null && oldHash !== current,
        added_lines: 0,
        removed_lines: 0,
        changed_blocks: 0,
        affected_old_range: null,
        affected_new_range: null,
        changes: [],
        truncated: false,
        impact_scope: oldHash !== null && oldHash !== current ? 'hash_only' : 'none',
        note: '当前 Artifact 文件无法读取，无法生成逐行差异。',
      }
    }
    const base = {
      artifact_id: artifact.id,
      artifact_name: artifact.name,
      old_hash: oldHash,
      new_hash: observed.sha256,
      changed: oldHash !== null && oldHash !== observed.sha256,
    }
    if (detail?.artifact_snapshot_path === null || detail?.artifact_snapshot_path === undefined || observed.text === null) {
      return {
        ...base,
        supported: observed.kind !== null,
        snapshot_available: false,
        snapshot_kind: detail?.artifact_snapshot_kind ?? observed.kind,
        added_lines: 0,
        removed_lines: 0,
        changed_blocks: base.changed ? 1 : 0,
        affected_old_range: null,
        affected_new_range: null,
        changes: [],
        truncated: false,
        impact_scope: base.changed ? 'hash_only' : 'none',
        note: base.changed ? '旧审核没有可用文本快照，仅能确认文件哈希已经变化。' : '文件哈希没有变化。',
      }
    }
    let oldText: string
    try {
      const snapshotPath = safeSnapshotPath(detail.artifact_snapshot_path, this.snapshotRoot())
      oldText = decodeText(readFileSync(snapshotPath))
    } catch {
      return {
        ...base,
        supported: observed.kind !== null,
        snapshot_available: false,
        snapshot_kind: detail.artifact_snapshot_kind,
        added_lines: 0,
        removed_lines: 0,
        changed_blocks: base.changed ? 1 : 0,
        affected_old_range: null,
        affected_new_range: null,
        changes: [],
        truncated: false,
        impact_scope: base.changed ? 'hash_only' : 'none',
        note: '审核文本快照当前不可读取，仅返回哈希比较。',
      }
    }
    const diff = boundedLineDiff(oldText, observed.text)
    return {
      ...base,
      supported: true,
      snapshot_available: true,
      snapshot_kind: detail.artifact_snapshot_kind,
      ...diff,
      note: base.changed ? '差异来自审核时文本快照与当前文件的逐行比较。' : '审核快照与当前文件一致。',
    }
  }
}
