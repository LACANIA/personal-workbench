import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  InputAsset,
  InputAssetView,
  InputCapability,
  NativeInputSelection,
  TemporaryInputGrant,
} from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { WorkbenchDatabase } from '../database.ts'
import { runProcess } from '../process.ts'
import { assertAllowedExisting } from '../security/path-policy.ts'

const MAX_STAGE_BYTES = 25 * 1024 * 1024
const GRANT_LIFETIME_MS = 4 * 60 * 60 * 1000
const STAGED_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.csv', '.py', '.ts', '.js', '.pdf', '.docx', '.pptx', '.xlsx',
  '.png', '.jpg', '.jpeg', '.srt', '.vtt',
])

const CAPABILITIES: InputCapability[] = [
  { extensions: ['.md', '.txt', '.json', '.csv', '.py', '.ts', '.js'], category: 'text/code', mode: 'native_read', label: '可直接分析', analyzable: true },
  { extensions: ['.srt', '.vtt'], category: 'subtitle', mode: 'current_parser', label: '可通过字幕解析器处理', analyzable: true },
  { extensions: ['.pdf'], category: 'pdf', mode: 'structured_parser', label: '可读取 PDF 文字，扫描页按需进行本机文字识别', analyzable: true },
  { extensions: ['.docx'], category: 'office', mode: 'structured_parser', label: '可读取 Word 的章节、文字和表格', analyzable: true },
  { extensions: ['.pptx'], category: 'office', mode: 'structured_parser', label: '可读取 PowerPoint 的课件文字和表格', analyzable: true },
  { extensions: ['.xlsx'], category: 'office', mode: 'structured_parser', label: '可读取 Excel 工作表、公式文本和基础统计', analyzable: true },
  { extensions: ['.png', '.jpg', '.jpeg'], category: 'image', mode: 'metadata_only', label: '当前只读取图像元数据', analyzable: false },
  { extensions: ['.mp4', '.mkv', '.mov', '.webm'], category: 'video', mode: 'current_parser', label: '需要本机媒体与 ASR 组件', analyzable: true },
  { extensions: ['.wav', '.mp3', '.m4a', '.flac'], category: 'audio', mode: 'current_parser', label: '需要本机 ASR 组件', analyzable: true },
]

const DIRECTORY_CAPABILITY: InputCapability = {
  extensions: [],
  category: 'directory',
  mode: 'native_read',
  label: '可执行受控目录统计',
  analyzable: true,
}

export interface PickerResult { canceled: boolean; path: string | null; kind: 'file' | 'directory' }
export type PickerRunner = (kind: 'file' | 'directory') => Promise<PickerResult>

function now(): string { return new Date().toISOString() }
function expiresAt(): string { return new Date(Date.now() + GRANT_LIFETIME_MS).toISOString() }

function pathKey(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function within(candidate: string, root: string): boolean {
  const child = pathKey(candidate)
  const parent = pathKey(root)
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

function denyUnsafePath(value: string): void {
  const win = value.replaceAll('/', '\\')
  const withoutDrive = /^[A-Za-z]:\\/u.test(win) ? win.slice(2) : win
  if (value.includes('\0') || win.startsWith('\\\\') || /^\\\\[?.]\\/u.test(win) || withoutDrive.includes(':')) {
    throw new Error('PATH_POLICY_DENIED')
  }
}

function mimeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  const values: Record<string, string> = {
    '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv',
    '.py': 'text/x-python', '.ts': 'text/typescript', '.js': 'text/javascript', '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.srt': 'application/x-subrip',
    '.vtt': 'text/vtt', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  }
  return values[extension] ?? 'application/octet-stream'
}

function capabilityForPath(filePath: string | null): InputCapability {
  if (filePath === null) return { extensions: [], category: 'unknown', mode: 'registered_only', label: '当前仅登记', analyzable: false }
  const extension = path.extname(filePath).toLowerCase()
  return CAPABILITIES.find(item => item.extensions.includes(extension))
    ?? { extensions: [extension], category: 'unknown', mode: 'registered_only', label: '当前仅登记', analyzable: false }
}

function safeFileName(value: string): string {
  if (value.length === 0 || value !== path.basename(value) || /[\\/]/u.test(value) || value.includes('\0') || value === '.' || value === '..') {
    throw new Error('INPUT_FILENAME_DENIED')
  }
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '').slice(0, 180)
  if (cleaned.length === 0 || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned)) throw new Error('INPUT_FILENAME_DENIED')
  return cleaned
}

async function defaultPicker(kind: 'file' | 'directory'): Promise<PickerResult> {
  const script = path.join(PATHS.appRoot, 'server', 'helpers', 'input-picker.ps1')
  const result = await runProcess('powershell.exe', [
    '-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Kind', kind,
  ], { timeoutMs: 10 * 60 * 1000, windowsHide: false })
  if (result.timedOut) throw new Error('INPUT_PICKER_TIMEOUT')
  if (result.exitCode !== 0) throw new Error(`INPUT_PICKER_FAILED: ${result.stderr.trim().slice(0, 500)}`)
  const line = result.stdout.trim().split(/\r?\n/u).at(-1)
  if (line === undefined) throw new Error('INPUT_PICKER_INVALID_RESPONSE')
  const parsed = JSON.parse(line) as PickerResult
  if (parsed.kind !== kind || typeof parsed.canceled !== 'boolean' || (!parsed.canceled && typeof parsed.path !== 'string')) {
    throw new Error('INPUT_PICKER_INVALID_RESPONSE')
  }
  return parsed
}

export class UniversalInputService {
  constructor(
    readonly database: WorkbenchDatabase,
    private readonly picker: PickerRunner = defaultPicker,
  ) {}

  capabilities(): { max_stage_bytes: number; staged_extensions: string[]; matrix: InputCapability[] } {
    return { max_stage_bytes: MAX_STAGE_BYTES, staged_extensions: [...STAGED_EXTENSIONS].sort(), matrix: CAPABILITIES }
  }

  async select(kind: 'file' | 'directory', userAction: boolean): Promise<NativeInputSelection> {
    if (userAction !== true) throw new Error('INPUT_PICKER_USER_ACTION_REQUIRED')
    const selected = await this.picker(kind)
    if (selected.canceled) return { canceled: true, path: null, kind, asset: null }
    if (selected.path === null) throw new Error('INPUT_PICKER_INVALID_RESPONSE')
    return this.registerSelectedPath(kind, selected.path, 'windows-native')
  }

  /**
   * Registers a path returned by Electron's native dialog. The HTTP route that
   * calls this method is protected by the private desktop bridge token; browser
   * clients cannot use it to grant themselves arbitrary filesystem access.
   */
  async registerDesktopSelection(kind: 'file' | 'directory', selectedPath: string): Promise<NativeInputSelection> {
    return this.registerSelectedPath(kind, selectedPath, 'electron-native')
  }

  private async registerSelectedPath(kind: 'file' | 'directory', selectedPath: string, picker: string): Promise<NativeInputSelection> {
    denyUnsafePath(selectedPath)
    const canonical = await realpath(path.resolve(selectedPath))
    const information = await stat(canonical)
    if ((kind === 'file' && !information.isFile()) || (kind === 'directory' && !information.isDirectory())) throw new Error('PATH_TYPE_MISMATCH')
    const createdAt = now()
    const expiry = expiresAt()
    const assetId = randomUUID()
    const asset = this.database.createInputAsset({
      id: assetId,
      input_type: kind,
      display_name: path.basename(canonical),
      original_path: canonical,
      staged_path: null,
      access_mode: 'temporary_grant',
      source_mode: 'native_picker',
      mime_type: kind === 'file' ? mimeFor(canonical) : 'inode/directory',
      size_bytes: kind === 'file' ? information.size : null,
      sha256: null,
      created_at: createdAt,
      expires_at: expiry,
      task_id: null,
      project_id: null,
      metadata: { picker, original_file_modified: false },
    })
    const grant = this.database.createTemporaryInputGrant({
      grant_id: randomUUID(), input_asset_id: assetId, selected_path: canonical, kind,
      scope: kind === 'file' ? 'exact_file' : 'directory_tree', created_at: createdAt,
      expires_at: expiry, task_id: null, status: 'granted', source_mode: 'native_picker',
    })
    return { canceled: false, path: canonical, kind, asset: this.view(asset.id, grant) }
  }

  async stage(fileName: string, data: Buffer, declaredMime?: string): Promise<InputAssetView> {
    if (data.length === 0) throw new Error('INPUT_STAGE_EMPTY')
    if (data.length > MAX_STAGE_BYTES) throw new Error('INPUT_STAGE_TOO_LARGE')
    const safeName = safeFileName(fileName)
    const extension = path.extname(safeName).toLowerCase()
    if (!STAGED_EXTENSIONS.has(extension)) throw new Error('INPUT_EXTENSION_UNSUPPORTED')
    const id = randomUUID()
    const targetDirectory = path.join(PATHS.personalInboxIncoming, id)
    await mkdir(targetDirectory, { recursive: true })
    const target = path.join(targetDirectory, safeName)
    const temporary = path.join(targetDirectory, `.${safeName}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, data, { flag: 'wx' })
      await rename(temporary, target)
    } catch (error) {
      await rm(targetDirectory, { recursive: true, force: true })
      throw error
    }
    const canonical = await assertAllowedExisting(target, 'file')
    const sha256 = createHash('sha256').update(data).digest('hex')
    const asset = this.database.createInputAsset({
      id, input_type: 'file', display_name: safeName, original_path: null, staged_path: canonical,
      access_mode: 'staged_copy', source_mode: 'drag_drop', mime_type: declaredMime?.slice(0, 200) || mimeFor(canonical),
      size_bytes: data.length, sha256, created_at: now(), expires_at: null, task_id: null, project_id: null,
      metadata: { original_file_modified: false, notice: '已导入分析副本，原始文件未修改。' },
    })
    return this.view(asset.id)
  }

  get(id: string): InputAssetView {
    const asset = this.database.getInputAsset(id)
    if (asset === undefined) throw new Error('INPUT_ASSET_NOT_FOUND')
    return this.view(id)
  }

  async deleteUnused(id: string): Promise<{ asset: InputAsset; original_deleted: false; staged_copy_deleted: boolean }> {
    const asset = this.database.getInputAsset(id)
    if (asset === undefined) throw new Error('INPUT_ASSET_NOT_FOUND')
    if (asset.task_id !== null) throw new Error('INPUT_ASSET_IN_USE')
    let stagedCopyDeleted = false
    if (asset.staged_path !== null) {
      const canonical = await assertAllowedExisting(asset.staged_path, 'file')
      if (!within(canonical, PATHS.personalInboxIncoming)) throw new Error('INPUT_STAGED_DELETE_DENIED')
      await rm(path.dirname(canonical), { recursive: true, force: true })
      stagedCopyDeleted = true
    }
    return { asset: this.database.deleteUnusedInputAsset(id), original_deleted: false, staged_copy_deleted: stagedCopyDeleted }
  }

  attachToTask(inputAssetId: string, taskId: string, projectId: string | null): InputAssetView {
    this.database.attachInputAssetToTask(inputAssetId, taskId, projectId)
    return this.get(inputAssetId)
  }

  async authorizedProjectRoot(inputAssetId: string): Promise<string> {
    const view = this.get(inputAssetId)
    if (view.asset.source_mode !== 'native_picker' || view.asset.input_type !== 'directory' || view.asset.original_path === null) {
      throw new Error('PROJECT_INPUT_AUTHORIZATION_REQUIRED')
    }
    if (view.grant === null || view.grant.scope !== 'directory_tree' || view.grant.status !== 'granted' || Date.parse(view.grant.expires_at) <= Date.now()) {
      throw new Error('PROJECT_INPUT_AUTHORIZATION_REQUIRED')
    }
    return realpath(view.asset.original_path)
  }

  promoteToProject(inputAssetId: string, projectId: string): InputAssetView {
    this.database.promoteInputAssetToProject(inputAssetId, projectId)
    return this.get(inputAssetId)
  }

  async assertTaskAccess(taskId: string, inputAssetId: string, inputPath: string, expected: 'file' | 'directory'): Promise<string> {
    const view = this.get(inputAssetId)
    if (view.asset.task_id !== taskId) throw new Error('INPUT_GRANT_TASK_MISMATCH')
    denyUnsafePath(inputPath)
    const canonical = await realpath(path.resolve(inputPath))
    const information = await stat(canonical)
    if ((expected === 'file' && !information.isFile()) || (expected === 'directory' && !information.isDirectory())) throw new Error('PATH_TYPE_MISMATCH')
    if (view.asset.access_mode === 'staged_copy') {
      if (view.asset.staged_path === null || pathKey(canonical) !== pathKey(view.asset.staged_path)) throw new Error('PATH_POLICY_DENIED')
      return canonical
    }
    const grant = view.grant
    if (grant === null || grant.status !== 'attached_to_task' || Date.parse(grant.expires_at) <= Date.now()) throw new Error('INPUT_GRANT_EXPIRED')
    const selected = await realpath(grant.selected_path)
    if (grant.scope === 'exact_file' ? pathKey(canonical) !== pathKey(selected) : !within(canonical, selected)) throw new Error('PATH_POLICY_DENIED')
    return canonical
  }

  async createTaskPolicyOverlay(taskId: string, inputAssetId: string | null, projectRoot: string | null = null): Promise<string | null> {
    const view = inputAssetId === null ? null : this.get(inputAssetId)
    if (view !== null && view.asset.task_id !== taskId) throw new Error('INPUT_GRANT_TASK_MISMATCH')
    if (view?.grant !== null && view?.grant !== undefined
      && (view.grant.status !== 'attached_to_task' || Date.parse(view.grant.expires_at) <= Date.now())) throw new Error('INPUT_GRANT_EXPIRED')
    if (view?.grant === null && projectRoot === null) return null
    const permanent = JSON.parse((await readFile(PATHS.policy, 'utf8')).replace(/^\uFEFF/u, '')) as Record<string, unknown>
    const runtimeDirectory = path.join(PATHS.temporaryInputRuntime, taskId)
    await rm(runtimeDirectory, { recursive: true, force: true })
    await mkdir(runtimeDirectory, { recursive: true })
    const policyPath = path.join(runtimeDirectory, 'input-policy.json')
    const policy = {
      ...permanent,
      allowedRoots: [
        ...(Array.isArray(permanent.allowedRoots) ? permanent.allowedRoots : []),
        ...(projectRoot === null ? [] : [projectRoot]),
        ...(view?.grant?.scope === 'directory_tree' ? [view.grant.selected_path] : []),
      ],
      allowedFiles: view?.grant?.scope === 'exact_file' ? [view.grant.selected_path] : [],
      temporaryGrant: view?.grant === null || view?.grant === undefined
        ? null
        : { grantId: view.grant.grant_id, taskId, expiresAt: view.grant.expires_at },
    }
    await writeFile(policyPath, JSON.stringify(policy, null, 2), { encoding: 'utf8', flag: 'wx' })
    const patchPath = path.join(runtimeDirectory, 'cordis.patch.yml')
    const quoted = policyPath.replaceAll("'", "''")
    await writeFile(patchPath, `- id: personal-safe-fs\n  config:\n    policyPath: '${quoted}'\n`, { encoding: 'utf8', flag: 'wx' })
    return patchPath
  }

  async expireForTask(taskId: string): Promise<TemporaryInputGrant[]> {
    const expired = this.database.expireInputGrantForTask(taskId)
    await rm(path.join(PATHS.temporaryInputRuntime, taskId), { recursive: true, force: true })
    return expired
  }

  effectivePath(id: string): string | null {
    const asset = this.database.getInputAsset(id)
    if (asset === undefined) throw new Error('INPUT_ASSET_NOT_FOUND')
    return asset.staged_path ?? asset.original_path
  }

  private view(id: string, suppliedGrant?: TemporaryInputGrant): InputAssetView {
    const asset = this.database.getInputAsset(id)
    if (asset === undefined) throw new Error('INPUT_ASSET_NOT_FOUND')
    const effective = asset.staged_path ?? asset.original_path
    return {
      asset,
      grant: suppliedGrant ?? this.database.getInputGrantForAsset(id) ?? null,
      effective_path: effective,
      capability: asset.input_type === 'directory' ? DIRECTORY_CAPABILITY : capabilityForPath(effective),
    }
  }
}
