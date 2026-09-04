import { spawn } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  ArtifactHealthCheck,
  ArtifactHistory,
  ArtifactPreview,
  ArtifactRecord,
  ArtifactStatus,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { assertAllowedExisting, loadAllowedRoots } from '../security/path-policy.ts'
import { ArtifactService, artifactBelongsToRoot, hashArtifactFile } from './service.ts'

const MAX_TEXT_PREVIEW_BYTES = 100 * 1024
const MAX_IMAGE_HEADER_BYTES = 1024 * 1024
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv'])
const CODE_EXTENSIONS = new Set(['.py', '.ts', '.js', '.cpp', '.java'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])

type OpenLocation = (canonicalFile: string) => Promise<void>
type OpenFile = (canonicalFile: string) => Promise<void>

function pathKey(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function unsafeStoredPath(value: string): boolean {
  const normalized = value.replaceAll('/', '\\')
  return !path.isAbsolute(value) || value.includes('\0') || normalized.startsWith('\\\\') || /^\\\\[?.]\\/u.test(normalized)
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function readPrefix(filePath: string, maximum: number): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const information = await handle.stat()
    const requested = Math.min(information.size, maximum)
    const buffer = Buffer.alloc(requested)
    const result = await handle.read(buffer, 0, requested, 0)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

function decodeUtf8Preview(buffer: Buffer, truncated: boolean): string {
  if (buffer.includes(0)) throw new Error('ARTIFACT_PREVIEW_BINARY_DENIED')
  const maximumTrim = truncated ? Math.min(3, buffer.length) : 0
  for (let trim = 0; trim <= maximumTrim; trim += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, buffer.length - trim)).replace(/^\uFEFF/u, '')
    } catch {
      if (trim === maximumTrim) throw new Error('ARTIFACT_PREVIEW_INVALID_UTF8')
    }
  }
  throw new Error('ARTIFACT_PREVIEW_INVALID_UTF8')
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('ARTIFACT_IMAGE_METADATA_INVALID')
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('ARTIFACT_IMAGE_METADATA_INVALID')
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1
    if (offset >= buffer.length) break
    const marker = buffer[offset]!
    offset += 1
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue
    if (marker === 0xda || offset + 1 >= buffer.length) break
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) break
    if (startOfFrame.has(marker) && length >= 7) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  throw new Error('ARTIFACT_IMAGE_METADATA_INVALID')
}

async function defaultOpenLocation(canonicalFile: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('ARTIFACT_OPEN_LOCATION_UNSUPPORTED')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('explorer.exe', ['/select,', canonicalFile], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

async function defaultOpenFile(canonicalFile: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('ARTIFACT_OPEN_FILE_UNSUPPORTED')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('explorer.exe', [canonicalFile], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export class ArtifactIntelligenceService {
  constructor(
    readonly database: WorkbenchDatabase,
    readonly artifacts: ArtifactService,
    private readonly openLocationHandler: OpenLocation = defaultOpenLocation,
    private readonly openFileHandler: OpenFile = defaultOpenFile,
  ) {}

  async preview(id: string): Promise<ArtifactPreview> {
    const artifact = this.artifacts.get(id)
    const canonical = await this.resolveExisting(artifact)
    const extension = path.extname(canonical).toLowerCase()
    const information = await stat(canonical)
    if (TEXT_EXTENSIONS.has(extension) || CODE_EXTENSIONS.has(extension)) {
      const truncated = information.size > MAX_TEXT_PREVIEW_BYTES
      const bytes = await readPrefix(canonical, MAX_TEXT_PREVIEW_BYTES)
      return {
        artifact,
        preview_type: CODE_EXTENSIONS.has(extension) ? 'code' : 'text',
        content: decodeUtf8Preview(bytes, truncated),
        truncated,
        width: null,
        height: null,
        mime: artifact.mime_type,
      }
    }
    if (IMAGE_EXTENSIONS.has(extension)) {
      const header = await readPrefix(canonical, MAX_IMAGE_HEADER_BYTES)
      const dimensions = extension === '.png' ? pngDimensions(header) : jpegDimensions(header)
      return {
        artifact,
        preview_type: 'image',
        content: null,
        truncated: false,
        width: dimensions.width,
        height: dimensions.height,
        mime: artifact.mime_type,
      }
    }
    throw new Error('ARTIFACT_PREVIEW_UNSUPPORTED')
  }

  async check(id: string): Promise<ArtifactHealthCheck> {
    return this.checkInternal(id, true)
  }

  async setArchived(id: string, archived: boolean): Promise<ArtifactRecord> {
    const artifact = this.artifacts.get(id)
    if (!archived) {
      await this.checkInternal(id, false)
      return this.artifacts.get(id)
    }
    const checkedAt = new Date().toISOString()
    const metadata = {
      ...artifact.metadata,
      previous_status: artifact.status,
      status_changed_at: artifact.status === 'archived' ? artifact.metadata.status_changed_at : checkedAt,
      last_checked_at: checkedAt,
    }
    return this.database.updateArtifactStatus(artifact.id, 'archived', metadata)
  }

  history(id: string): ArtifactHistory {
    return this.artifacts.history(id)
  }

  async openLocation(id: string): Promise<{ artifact_id: string; opened: true }> {
    const artifact = this.artifacts.get(id)
    const canonical = await this.resolveExisting(artifact)
    await this.openLocationHandler(canonical)
    return { artifact_id: artifact.id, opened: true }
  }

  async openFile(id: string): Promise<{ artifact_id: string; opened: true }> {
    const artifact = this.artifacts.get(id)
    const canonical = await this.resolveExisting(artifact)
    await this.openFileHandler(canonical)
    return { artifact_id: artifact.id, opened: true }
  }

  private async checkInternal(id: string, preserveArchived: boolean): Promise<ArtifactHealthCheck> {
    const artifact = this.artifacts.get(id)
    await this.validateStoredLocation(artifact)
    const checkedAt = new Date().toISOString()
    let currentHash: string | null = null
    let observedStatus: Exclude<ArtifactStatus, 'archived'>
    try {
      const canonical = await this.resolveExisting(artifact)
      currentHash = await hashArtifactFile(canonical)
      observedStatus = currentHash === artifact.sha256 ? 'active' : 'outdated'
    } catch (error) {
      if (!missing(error) && !(error instanceof Error && error.message === 'ARTIFACT_FILE_NOT_FOUND')) throw error
      observedStatus = 'missing'
    }
    const status = preserveArchived && artifact.status === 'archived' ? 'archived' : observedStatus
    const changed = status !== artifact.status
    const metadata = {
      ...artifact.metadata,
      last_checked_at: checkedAt,
      current_hash: currentHash,
      ...(changed ? { previous_status: artifact.status, status_changed_at: checkedAt } : {}),
    }
    this.database.updateArtifactStatus(artifact.id, status, metadata)
    return {
      artifact_id: artifact.id,
      previous_hash: artifact.sha256,
      current_hash: currentHash,
      previous_status: artifact.status,
      status,
      observed_status: observedStatus,
      checked_at: checkedAt,
    }
  }

  private async validateStoredLocation(artifact: ArtifactRecord): Promise<void> {
    const project = this.database.getProjectContext(artifact.project_id)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    if (unsafeStoredPath(artifact.absolute_path)) throw new Error('PATH_POLICY_DENIED')
    const resolved = path.resolve(artifact.absolute_path)
    const roots = await loadAllowedRoots()
    if (!roots.some(root => pathKey(resolved) === pathKey(root) || pathKey(resolved).startsWith(`${pathKey(root)}${path.sep}`))) {
      throw new Error('PATH_POLICY_DENIED')
    }
    if (!artifactBelongsToRoot(resolved, project.rootPath)) throw new Error('ARTIFACT_PROJECT_PATH_DENIED')
  }

  private async resolveExisting(artifact: ArtifactRecord): Promise<string> {
    await this.validateStoredLocation(artifact)
    let canonical: string
    try {
      canonical = await assertAllowedExisting(artifact.absolute_path, 'file')
    } catch (error) {
      if (missing(error)) throw new Error('ARTIFACT_FILE_NOT_FOUND')
      throw error
    }
    const project = this.database.getProjectContext(artifact.project_id)
    if (project === undefined || !artifactBelongsToRoot(canonical, project.rootPath)) throw new Error('ARTIFACT_PROJECT_PATH_DENIED')
    return canonical
  }
}
