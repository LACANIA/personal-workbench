import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PortableWorkbenchConfig } from '../../shared/contracts/index.ts'

export type LocalWorkbenchConfig = PortableWorkbenchConfig

export interface LocalConfigOptions {
  appRoot?: string
  configPath?: string
  environment?: NodeJS.ProcessEnv
}

export const DETECTED_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONFIG_VERSION = 5

function requiredText(value: unknown, field: keyof LocalWorkbenchConfig, maximum = 2048): string {
  if (typeof value !== 'string') throw new Error(`LOCAL_CONFIG_INVALID_${field.toUpperCase()}`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum || normalized.includes('\0')) {
    throw new Error(`LOCAL_CONFIG_INVALID_${field.toUpperCase()}`)
  }
  return normalized
}

function nullablePath(value: unknown, field: keyof LocalWorkbenchConfig): string | null {
  if (value === null || value === undefined || value === '') return null
  const normalized = path.resolve(requiredText(value, field))
  if (!path.isAbsolute(normalized)) throw new Error(`LOCAL_CONFIG_INVALID_${field.toUpperCase()}`)
  return normalized
}

function nullableTimestamp(value: unknown, field: keyof LocalWorkbenchConfig): string | null {
  if (value === null || value === undefined || value === '') return null
  const text = requiredText(value, field, 64)
  if (Number.isNaN(Date.parse(text))) throw new Error(`LOCAL_CONFIG_INVALID_${field.toUpperCase()}`)
  return new Date(text).toISOString()
}

function pathKey(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function belongsToRoot(candidate: string, root: string): boolean {
  const candidateKey = pathKey(candidate)
  const rootKey = pathKey(root)
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${path.sep}`)
}

function localEndpoint(value: unknown): string {
  let candidate = requiredText(value, 'ollama_endpoint', 512)
  if (!/^https?:\/\//iu.test(candidate)) candidate = `http://${candidate}`
  let parsed: URL
  try { parsed = new URL(candidate) } catch { throw new Error('LOCAL_CONFIG_INVALID_OLLAMA_ENDPOINT') }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('LOCAL_CONFIG_OLLAMA_ENDPOINT_NOT_LOOPBACK')
  }
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('LOCAL_CONFIG_INVALID_OLLAMA_ENDPOINT')
  }
  return parsed.toString().replace(/\/$/u, '')
}

function executableNames(name: string): string[] {
  if (process.platform !== 'win32') return [name]
  return name.toLowerCase().endsWith('.exe') ? [name] : [`${name}.exe`, `${name}.cmd`, `${name}.bat`]
}

function detectExecutable(name: string, configured: string | undefined, environment: NodeJS.ProcessEnv): string | null {
  if (configured !== undefined && configured.trim().length > 0) return path.resolve(configured)
  for (const directory of (environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const candidateName of executableNames(name)) {
      const candidate = path.resolve(directory.replace(/^"|"$/gu, ''), candidateName)
      if (existsSync(candidate)) return candidate
    }
  }
  if (name === 'ollama' && process.platform === 'win32' && environment.LOCALAPPDATA !== undefined) {
    const candidate = path.join(environment.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

function detectedProjectPath(appRoot: string): string {
  return path.basename(path.dirname(appRoot)).toLowerCase() === 'apps'
    ? path.resolve(appRoot, '..', '..')
    : path.resolve(appRoot)
}

export function detectLocalConfig(appRoot = DETECTED_APP_ROOT, environment: NodeJS.ProcessEnv = process.env): LocalWorkbenchConfig {
  const desktop = environment.PERSONAL_WORKBENCH_DESKTOP === '1'
  const projectPath = desktop ? path.resolve(appRoot) : detectedProjectPath(appRoot)
  const workspaceRoot = desktop ? projectPath : path.resolve(projectPath, '..')
  const mediaRoot = path.join(projectPath, 'runtime', 'media')
  const localBinary = (name: string): string | null => {
    const candidate = path.join(mediaRoot, 'bin', process.platform === 'win32' ? `${name}.exe` : name)
    return existsSync(candidate) ? candidate : null
  }
  const asrPython = path.join(mediaRoot, 'asr', '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
  const asrModel = path.join(mediaRoot, 'models', 'faster-whisper-small')
  const asrGpuRuntimeRoot = path.join(mediaRoot, 'gpu-runtime')
  const gpuDllRoot = path.join(asrGpuRuntimeRoot, 'python-packages', 'nvidia')
  const asrGpuAvailable = [
    path.join(gpuDllRoot, 'cublas', 'bin', 'cublas64_12.dll'),
    path.join(gpuDllRoot, 'cudnn', 'bin', 'cudnn64_9.dll'),
    path.join(gpuDllRoot, 'cuda_runtime', 'bin', 'cudart64_12.dll'),
  ].every(existsSync)
  return {
    config_version: CONFIG_VERSION,
    workspace_root: workspaceRoot,
    ollama_endpoint: localEndpoint(environment.PERSONAL_WORKBENCH_OLLAMA_ENDPOINT ?? environment.OLLAMA_HOST ?? 'http://127.0.0.1:11434'),
    model_name: requiredText(environment.PERSONAL_WORKBENCH_MODEL ?? 'qwen3:8b', 'model_name', 128),
    memory_path: desktop ? path.join(projectPath, 'data', 'research-memory.db') : path.join(projectPath, 'memory', 'database', 'research_memory.db'),
    project_path: projectPath,
    harness_root: desktop ? path.join(projectPath, 'runtime', 'harness') : path.join(workspaceRoot, 'deepseek-harness'),
    dsh_home: desktop ? path.join(projectPath, 'runtime', 'dsh-home') : path.join(workspaceRoot, 'dsh-home'),
    backup_root: desktop ? path.join(projectPath, 'backup') : path.join(appRoot, 'data', 'backups'),
    ollama_executable: detectExecutable('ollama', environment.PERSONAL_WORKBENCH_OLLAMA_EXE, environment),
    ffmpeg_executable: detectExecutable('ffmpeg', environment.PERSONAL_WORKBENCH_FFMPEG_EXE, environment) ?? localBinary('ffmpeg'),
    ffprobe_executable: detectExecutable('ffprobe', environment.PERSONAL_WORKBENCH_FFPROBE_EXE, environment) ?? localBinary('ffprobe'),
    ytdlp_executable: detectExecutable('yt-dlp', environment.PERSONAL_WORKBENCH_YTDLP_EXE, environment) ?? localBinary('yt-dlp'),
    asr_python: nullablePath(environment.PERSONAL_WORKBENCH_ASR_PYTHON ?? (existsSync(asrPython) ? asrPython : null), 'asr_python'),
    asr_model_path: nullablePath(environment.PERSONAL_WORKBENCH_ASR_MODEL ?? (existsSync(asrModel) ? asrModel : null), 'asr_model_path'),
    asr_device: ['auto', 'cuda', 'cpu'].includes(environment.PERSONAL_WORKBENCH_ASR_DEVICE ?? '') ? environment.PERSONAL_WORKBENCH_ASR_DEVICE as 'auto' | 'cuda' | 'cpu' : 'auto',
    asr_compute_type: environment.PERSONAL_WORKBENCH_ASR_COMPUTE_TYPE?.trim() || 'float16',
    asr_gpu_runtime_root: nullablePath(environment.PERSONAL_WORKBENCH_ASR_GPU_RUNTIME ?? asrGpuRuntimeRoot, 'asr_gpu_runtime_root'),
    asr_gpu_available: asrGpuAvailable,
    asr_last_diagnostic_at: null,
    embedding_provider: desktop ? 'ollama' : 'auto',
    embedding_model: desktop ? 'qwen3-embedding:0.6b' : null,
    embedding_dimension: desktop ? 1024 : 256,
    interface_mode: 'consumer',
    first_run_completed: false,
  }
}

function migrateConfig(value: unknown, detected: LocalWorkbenchConfig): LocalWorkbenchConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('LOCAL_CONFIG_INVALID_OBJECT')
  const row = value as Record<string, unknown>
  const legacy = row.config_version === undefined
  return {
    ...detected,
    ...row,
    config_version: CONFIG_VERSION,
    first_run_completed: typeof row.first_run_completed === 'boolean' ? row.first_run_completed : legacy,
  } as LocalWorkbenchConfig
}

export function validateLocalConfig(value: unknown): LocalWorkbenchConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('LOCAL_CONFIG_INVALID_OBJECT')
  const row = value as Record<string, unknown>
  const configVersion = Number(row.config_version)
  if (!Number.isInteger(configVersion) || configVersion !== CONFIG_VERSION) throw new Error('LOCAL_CONFIG_VERSION_UNSUPPORTED')
  const workspaceRoot = path.resolve(requiredText(row.workspace_root, 'workspace_root'))
  const projectPath = path.resolve(requiredText(row.project_path, 'project_path'))
  const memoryPath = path.resolve(requiredText(row.memory_path, 'memory_path'))
  const harnessRoot = path.resolve(requiredText(row.harness_root, 'harness_root'))
  const dshHome = path.resolve(requiredText(row.dsh_home, 'dsh_home'))
  const backupRoot = path.resolve(requiredText(row.backup_root, 'backup_root'))
  if (![workspaceRoot, projectPath, memoryPath, harnessRoot, dshHome, backupRoot].every(path.isAbsolute)) {
    throw new Error('LOCAL_CONFIG_PATH_NOT_ABSOLUTE')
  }
  if (!belongsToRoot(projectPath, workspaceRoot) || !belongsToRoot(memoryPath, projectPath)
    || !belongsToRoot(harnessRoot, workspaceRoot) || !belongsToRoot(dshHome, workspaceRoot)
    || !belongsToRoot(backupRoot, workspaceRoot)) {
    throw new Error('LOCAL_CONFIG_PATH_BOUNDARY_DENIED')
  }
  if (typeof row.first_run_completed !== 'boolean') throw new Error('LOCAL_CONFIG_INVALID_FIRST_RUN_COMPLETED')
  if (typeof row.asr_gpu_available !== 'boolean') throw new Error('LOCAL_CONFIG_INVALID_ASR_GPU_AVAILABLE')
  const asrDevice = row.asr_device
  if (!['auto', 'cuda', 'cpu'].includes(String(asrDevice))) throw new Error('LOCAL_CONFIG_INVALID_ASR_DEVICE')
  const embeddingProvider = row.embedding_provider
  if (!['auto', 'ollama', 'local-hash-v1'].includes(String(embeddingProvider))) throw new Error('LOCAL_CONFIG_INVALID_EMBEDDING_PROVIDER')
  const embeddingDimension = Number(row.embedding_dimension)
  if (!Number.isInteger(embeddingDimension) || embeddingDimension < 1 || embeddingDimension > 4096) throw new Error('LOCAL_CONFIG_INVALID_EMBEDDING_DIMENSION')
  const interfaceMode = row.interface_mode
  if (!['consumer', 'advanced'].includes(String(interfaceMode))) throw new Error('LOCAL_CONFIG_INVALID_INTERFACE_MODE')
  return {
    config_version: configVersion,
    workspace_root: workspaceRoot,
    ollama_endpoint: localEndpoint(row.ollama_endpoint),
    model_name: requiredText(row.model_name, 'model_name', 128),
    memory_path: memoryPath,
    project_path: projectPath,
    harness_root: harnessRoot,
    dsh_home: dshHome,
    backup_root: backupRoot,
    ollama_executable: nullablePath(row.ollama_executable, 'ollama_executable'),
    ffmpeg_executable: nullablePath(row.ffmpeg_executable, 'ffmpeg_executable'),
    ffprobe_executable: nullablePath(row.ffprobe_executable, 'ffprobe_executable'),
    ytdlp_executable: nullablePath(row.ytdlp_executable, 'ytdlp_executable'),
    asr_python: nullablePath(row.asr_python, 'asr_python'),
    asr_model_path: nullablePath(row.asr_model_path, 'asr_model_path'),
    asr_device: asrDevice as LocalWorkbenchConfig['asr_device'],
    asr_compute_type: requiredText(row.asr_compute_type, 'asr_compute_type', 32),
    asr_gpu_runtime_root: nullablePath(row.asr_gpu_runtime_root, 'asr_gpu_runtime_root'),
    asr_gpu_available: row.asr_gpu_available,
    asr_last_diagnostic_at: nullableTimestamp(row.asr_last_diagnostic_at, 'asr_last_diagnostic_at'),
    embedding_provider: embeddingProvider as LocalWorkbenchConfig['embedding_provider'],
    embedding_model: row.embedding_model === null || row.embedding_model === undefined ? null : requiredText(row.embedding_model, 'embedding_model', 128),
    embedding_dimension: embeddingDimension,
    interface_mode: interfaceMode as LocalWorkbenchConfig['interface_mode'],
    first_run_completed: row.first_run_completed,
  }
}

function writeConfig(configPath: string, config: LocalWorkbenchConfig): void {
  mkdirSync(path.dirname(configPath), { recursive: true })
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  renameSync(temporary, configPath)
}

export function loadOrCreateLocalConfig(options: LocalConfigOptions = {}): LocalWorkbenchConfig {
  const appRoot = path.resolve(options.appRoot ?? DETECTED_APP_ROOT)
  const configPath = path.resolve(options.configPath ?? path.join(appRoot, 'local-config.json'))
  if (!belongsToRoot(configPath, appRoot)) throw new Error('LOCAL_CONFIG_PATH_BOUNDARY_DENIED')
  const detected = detectLocalConfig(appRoot, options.environment)
  if (!existsSync(configPath)) {
    const created = validateLocalConfig(detected)
    writeConfig(configPath, created)
    return created
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, '')) as unknown
  const migrated = validateLocalConfig(migrateConfig(raw, detected))
  if (JSON.stringify(raw) !== JSON.stringify(migrated)) writeConfig(configPath, migrated)
  return migrated
}

export function saveLocalConfig(configPath: string, value: unknown): LocalWorkbenchConfig {
  const absolute = path.resolve(configPath)
  const validated = validateLocalConfig(value)
  writeConfig(absolute, validated)
  return validated
}

export function defaultLegacyRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(environment.VIDEO2SKILL_LEGACY_ROOT ?? path.join(os.homedir(), 'Desktop', 'Video2Skill'))
}
