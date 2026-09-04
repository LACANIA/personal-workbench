import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { opendir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  type ArtifactCandidate,
  type ArtifactHistory,
  type ArtifactQuery,
  type ArtifactRecord,
  type ArtifactRegisterInput,
  type ArtifactType,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { assertAllowedExisting } from '../security/path-policy.ts'

const DISCOVERABLE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.xlsx', '.png', '.jpg'])
const MAX_DISCOVERED_CANDIDATES = 200
const MAX_DISCOVERY_DEPTH = 6
const DISCOVERY_TIMEOUT_MS = 5000

const MIME_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.py': 'text/x-python',
  '.log': 'text/plain',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

function pathKey(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function artifactBelongsToRoot(candidate: string, root: string): boolean {
  const candidateKey = pathKey(candidate)
  const rootKey = pathKey(root)
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${path.sep}`)
}

function requiredText(value: unknown, field: string, maximum = 1024): string {
  if (typeof value !== 'string') throw new Error(`INVALID_ARTIFACT_${field.toUpperCase()}`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum || normalized.includes('\0')) {
    throw new Error(`INVALID_ARTIFACT_${field.toUpperCase()}`)
  }
  return normalized
}

function optionalName(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  return requiredText(value, 'name', 255)
}

function artifactType(value: unknown, filePath: string): ArtifactType {
  if (value === undefined) return inferArtifactType(filePath)
  if (typeof value !== 'string' || !ARTIFACT_TYPES.includes(value as ArtifactType)) throw new Error('INVALID_ARTIFACT_TYPE')
  return value as ArtifactType
}

function inferArtifactType(filePath: string): ArtifactType {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.md' || extension === '.markdown') return /report/iu.test(path.basename(filePath)) ? 'report' : 'document'
  if (extension === '.txt' || extension === '.pdf') return 'document'
  if (['.ts', '.tsx', '.js', '.mjs', '.py'].includes(extension)) return 'code'
  if (['.json', '.csv', '.xlsx'].includes(extension)) return 'dataset'
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(extension)) return 'image'
  if (['.mp4', '.webm'].includes(extension)) return 'video'
  if (['.mp3', '.wav'].includes(extension)) return 'audio'
  if (extension === '.log') return 'log'
  return 'other'
}

export function artifactMimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function metadata(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARTIFACT_METADATA')
  const serialized = JSON.stringify(value)
  if (serialized.length > 32_768) throw new Error('INVALID_ARTIFACT_METADATA')
  return JSON.parse(serialized) as Record<string, unknown>
}

export async function hashArtifactFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface ArtifactRegistrationEvidenceLinker {
  linkRegistration(artifact: ArtifactRecord, input: ArtifactRegisterInput): unknown
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class ArtifactService {
  constructor(
    readonly database: WorkbenchDatabase,
    private readonly evidence?: ArtifactRegistrationEvidenceLinker,
  ) {}

  async register(input: ArtifactRegisterInput): Promise<ArtifactRecord> {
    if (input === null || typeof input !== 'object') throw new Error('INVALID_ARTIFACT_INPUT')
    if (input.auto_link_task !== undefined && typeof input.auto_link_task !== 'boolean') throw new Error('INVALID_ARTIFACT_AUTO_LINK_TASK')
    if (input.auto_link_session !== undefined && typeof input.auto_link_session !== 'boolean') throw new Error('INVALID_ARTIFACT_AUTO_LINK_SESSION')
    if (input.evidence !== undefined && (!Array.isArray(input.evidence) || input.evidence.length > 50)) throw new Error('INVALID_ARTIFACT_EVIDENCE')
    const projectId = requiredText(input.project_id, 'project_id', 128)
    const project = this.database.getProjectContext(projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')

    const filePath = requiredText(input.file_path, 'file_path', 2048)
    let canonical: string
    try {
      canonical = await assertAllowedExisting(filePath, 'file')
    } catch (error) {
      if (isMissing(error)) throw new Error('ARTIFACT_FILE_NOT_FOUND')
      throw error
    }
    if (!artifactBelongsToRoot(canonical, project.rootPath)) throw new Error('ARTIFACT_PROJECT_PATH_DENIED')

    const taskId = input.task_id === undefined ? null : requiredText(input.task_id, 'task_id', 128)
    if (taskId !== null) {
      const task = this.database.getTask(taskId)
      if (task === undefined) throw new Error('TASK_NOT_FOUND')
      if (task.projectId !== project.id) throw new Error('INVALID_ARTIFACT_TASK_PROJECT')
    }

    const supersedesId = input.supersedes_artifact_id === undefined
      ? null
      : requiredText(input.supersedes_artifact_id, 'supersedes_artifact_id', 128)
    const superseded = supersedesId === null ? null : this.get(supersedesId)
    if (superseded !== null && superseded.project_id !== project.id) throw new Error('ARTIFACT_VERSION_PROJECT_MISMATCH')
    const changeNote = input.change_note === undefined ? '' : requiredText(input.change_note, 'change_note', 2048)

    const before = await stat(canonical)
    const sha256 = await hashArtifactFile(canonical)
    const after = await stat(canonical)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('ARTIFACT_CHANGED_DURING_HASH')

    const existing = this.database.findArtifactByIdentity(project.id, taskId, canonical, sha256)
    if (existing !== undefined) {
      if (superseded !== null && superseded.id !== existing.id && !this.database.getArtifactLineageIds(existing.id).includes(superseded.id)) {
        throw new Error('ARTIFACT_EXISTING_VERSION_LINK_CONFLICT')
      }
      this.markCandidateRegistered(taskId, canonical, existing.id)
      this.evidence?.linkRegistration(existing, input)
      return existing
    }

    const artifactId = randomUUID()
    const createdAt = new Date().toISOString()
    const versionNumber = superseded === null ? 1 : this.database.nextArtifactVersionNumber(superseded.id)
    const created = this.database.createArtifact({
      id: artifactId,
      project_id: project.id,
      task_id: taskId,
      artifact_type: artifactType(input.artifact_type, canonical),
      name: optionalName(input.name, path.basename(canonical)),
      relative_path: path.relative(project.rootPath, canonical),
      absolute_path: canonical,
      mime_type: artifactMimeType(canonical),
      size_bytes: after.size,
      sha256,
      status: 'active',
      version_count: versionNumber,
      created_at: createdAt,
      metadata: metadata(input.metadata),
    }, {
      id: randomUUID(),
      artifact_id: artifactId,
      version_number: versionNumber,
      sha256,
      size_bytes: after.size,
      created_at: createdAt,
      change_note: changeNote,
    }, superseded === null ? undefined : {
      id: randomUUID(),
      old_artifact_id: superseded.id,
      new_artifact_id: artifactId,
      relation: 'supersedes',
      created_at: createdAt,
    })
    if (created.task_id !== null) {
      this.markCandidateRegistered(created.task_id, created.absolute_path, created.id)
      this.database.addEvent(created.task_id, 'artifact.registered', 'workbench', {
        artifactId: created.id,
        name: created.name,
        artifactType: created.artifact_type,
        relativePath: created.relative_path,
      })
    }
    this.evidence?.linkRegistration(created, input)
    return created
  }

  private markCandidateRegistered(taskId: string | null, absolutePath: string, artifactId: string): void {
    if (taskId === null) return
    const task = this.database.getTask(taskId)
    if (task === undefined) return
    let changed = false
    const candidates = task.artifactIndex.map(item => {
      if (item === null || typeof item !== 'object') return item
      const candidate = item as Record<string, unknown>
      if (typeof candidate.absolute_path !== 'string' || pathKey(candidate.absolute_path) !== pathKey(absolutePath)) return item
      changed = true
      return { ...candidate, registered_artifact_id: artifactId }
    })
    if (changed) this.database.updateTask(taskId, { artifactIndex: candidates })
  }

  query(filters: ArtifactQuery = {}): ArtifactRecord[] {
    if (filters.project_id !== undefined) requiredText(filters.project_id, 'project_id', 128)
    if (filters.task_id !== undefined) requiredText(filters.task_id, 'task_id', 128)
    if (filters.artifact_type !== undefined) artifactType(filters.artifact_type, '')
    if (filters.status !== undefined && !ARTIFACT_STATUSES.includes(filters.status)) throw new Error('INVALID_ARTIFACT_STATUS')
    return this.database.listArtifacts(filters)
  }

  get(id: string): ArtifactRecord {
    const artifact = this.database.getArtifact(requiredText(id, 'id', 128))
    if (artifact === undefined) throw new Error('ARTIFACT_NOT_FOUND')
    return artifact
  }

  deleteIndex(id: string): ArtifactRecord {
    const artifact = this.get(id)
    this.database.deleteArtifact(artifact.id)
    return artifact
  }

  history(id: string): ArtifactHistory {
    const current = this.get(id)
    const lineageIds = this.database.getArtifactLineageIds(current.id)
    const versions = this.database.listArtifactVersions(lineageIds)
    const versionByArtifact = new Map(versions.map(version => [version.artifact_id, version.version_number]))
    const artifacts = this.database.listArtifactRecordsByIds(lineageIds)
      .sort((left, right) => (versionByArtifact.get(left.id) ?? 0) - (versionByArtifact.get(right.id) ?? 0) || left.created_at.localeCompare(right.created_at))
    return {
      current_artifact_id: current.id,
      version_count: versions.length,
      artifacts,
      versions,
      links: this.database.listArtifactVersionLinks(lineageIds),
    }
  }

  async discoverTaskCandidates(taskId: string): Promise<ArtifactCandidate[]> {
    const task = this.database.getTask(requiredText(taskId, 'task_id', 128))
    if (task === undefined) throw new Error('TASK_NOT_FOUND')
    if (task.projectId === null) return []
    const project = this.database.getProjectContext(task.projectId)
    if (project === undefined) return []

    const workspace = await assertAllowedExisting(task.workspacePath ?? project.rootPath, 'directory')
    if (!artifactBelongsToRoot(workspace, project.rootPath)) throw new Error('ARTIFACT_PROJECT_PATH_DENIED')
    const basename = path.basename(workspace).toLowerCase()
    const possibleRoots = basename === 'output' || basename === 'outputs'
      ? [workspace]
      : [path.join(workspace, 'output'), path.join(workspace, 'outputs')]
    const discovered: ArtifactCandidate[] = []
    const deadline = performance.now() + DISCOVERY_TIMEOUT_MS
    const registered = new Map(this.database.listArtifacts({ project_id: project.id, task_id: task.id, limit: 500 })
      .map(item => [pathKey(item.absolute_path), item.id]))

    for (const possibleRoot of possibleRoots) {
      if (discovered.length >= MAX_DISCOVERED_CANDIDATES) break
      let outputRoot: string
      try {
        outputRoot = await assertAllowedExisting(possibleRoot, 'directory')
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      if (!artifactBelongsToRoot(outputRoot, project.rootPath) || !artifactBelongsToRoot(outputRoot, workspace)) {
        throw new Error('ARTIFACT_PROJECT_PATH_DENIED')
      }
      await this.walkOutputDirectory(outputRoot, outputRoot, project.id, task.id, registered, discovered, deadline, 0)
    }

    return discovered
      .sort((left, right) => left.relative_path.localeCompare(right.relative_path))
      .slice(0, MAX_DISCOVERED_CANDIDATES)
  }

  private async walkOutputDirectory(
    current: string,
    outputRoot: string,
    projectId: string,
    taskId: string,
    registered: Map<string, string>,
    results: ArtifactCandidate[],
    deadline: number,
    depth: number,
  ): Promise<void> {
    if (performance.now() > deadline) throw new Error('ARTIFACT_DISCOVERY_TIMEOUT')
    if (results.length >= MAX_DISCOVERED_CANDIDATES || depth > MAX_DISCOVERY_DEPTH) return
    const directory = await opendir(current)
    for await (const entry of directory) {
      if (results.length >= MAX_DISCOVERED_CANDIDATES) return
      if (performance.now() > deadline) throw new Error('ARTIFACT_DISCOVERY_TIMEOUT')
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        const canonicalDirectory = await realpath(entryPath)
        if (!artifactBelongsToRoot(canonicalDirectory, outputRoot)) continue
        await this.walkOutputDirectory(canonicalDirectory, outputRoot, projectId, taskId, registered, results, deadline, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const extension = path.extname(entry.name).toLowerCase()
      if (!DISCOVERABLE_EXTENSIONS.has(extension)) continue
      const canonicalFile = await realpath(entryPath)
      if (!artifactBelongsToRoot(canonicalFile, outputRoot)) continue
      const info = await stat(canonicalFile)
      results.push({
        project_id: projectId,
        task_id: taskId,
        artifact_type: inferArtifactType(canonicalFile),
        name: path.basename(canonicalFile),
        relative_path: path.relative(outputRoot, canonicalFile),
        absolute_path: canonicalFile,
        mime_type: artifactMimeType(canonicalFile),
        size_bytes: info.size,
        modified_at: info.mtime.toISOString(),
        registered_artifact_id: registered.get(pathKey(canonicalFile)) ?? null,
      })
    }
  }
}
