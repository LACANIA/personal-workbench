import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type {
  AsrBenchmarkReport,
  AsrGpuDllStatus,
  AsrGpuRuntimeDiagnostics,
} from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { runProcess } from '../process.ts'

interface RuntimeManifest {
  packages?: Array<{ name?: string; version?: string }>
  dlls?: Array<{ name?: string; relative_path?: string; size_bytes?: number; sha256?: string }>
}

export interface AsrWorkerLaunch {
  environment: NodeJS.ProcessEnv
  runtimeRoot: string | null
  runtimeAvailable: boolean
  dllDirectories: string[]
  fallbackReason: string | null
}

const REQUIRED_DLLS = [
  ['cublas64_12.dll', 'cublas', 'bin'],
  ['cublasLt64_12.dll', 'cublas', 'bin'],
  ['cudnn64_9.dll', 'cudnn', 'bin'],
  ['cudnn_ops64_9.dll', 'cudnn', 'bin'],
  ['cudart64_12.dll', 'cuda_runtime', 'bin'],
] as const

function packageRoot(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'python-packages', 'nvidia')
}

function dllDirectories(runtimeRoot: string): string[] {
  const root = packageRoot(runtimeRoot)
  return [path.join(root, 'cublas', 'bin'), path.join(root, 'cudnn', 'bin'), path.join(root, 'cuda_runtime', 'bin')]
}

function requiredDllPaths(runtimeRoot: string): Array<{ name: string; path: string }> {
  const root = packageRoot(runtimeRoot)
  return REQUIRED_DLLS.map(([name, component, directory]) => ({ name, path: path.join(root, component, directory, name) }))
}

function manifest(runtimeRoot: string): RuntimeManifest | null {
  const file = path.join(runtimeRoot, 'gpu-runtime-manifest.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')) as RuntimeManifest } catch { return null }
}

function benchmark(runtimeRoot: string): AsrBenchmarkReport | null {
  const file = path.join(runtimeRoot, 'last-benchmark.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')) as AsrBenchmarkReport } catch { return null }
}

function fallbackValidation(runtimeRoot: string): AsrGpuRuntimeDiagnostics['fallback_validation'] {
  const file = path.join(runtimeRoot, 'last-fallback.json')
  if (!existsSync(file)) return null
  try {
    const value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')) as AsrGpuRuntimeDiagnostics['fallback_validation']
    return value?.fallback_used === true && value.resolved_device === 'cpu' ? value : null
  } catch { return null }
}

function packageVersion(row: RuntimeManifest | null, name: string): string | null {
  const value = row?.packages?.find(item => item.name === name)?.version
  return typeof value === 'string' ? value : null
}

function nvidiaSmi(): string | null {
  const fileName = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi'
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory.replace(/^"|"$/gu, ''), fileName)
    if (existsSync(candidate)) return candidate
  }
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) {
    const candidate = path.join(process.env.SystemRoot, 'System32', fileName)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function parseGpuRow(value: string): { name: string | null; driver: string | null; memory: number | null } {
  const row = value.split(/\r?\n/u).find(Boolean)?.split(',').map(item => item.trim()) ?? []
  const memory = Number(row[2])
  return { name: row[0] ?? null, driver: row[1] ?? null, memory: Number.isFinite(memory) ? memory : null }
}

export class AsrDiagnosticsService {
  workerLaunch(environment: NodeJS.ProcessEnv = process.env): AsrWorkerLaunch {
    const runtimeRoot = PATHS.asrGpuRuntimeRoot
    if (runtimeRoot === null) {
      return { environment: { ...environment }, runtimeRoot: null, runtimeAvailable: false, dllDirectories: [], fallbackReason: 'ASR_GPU_RUNTIME_ROOT_NOT_CONFIGURED' }
    }
    const required = requiredDllPaths(runtimeRoot)
    const missing = required.filter(item => !existsSync(item.path))
    if (missing.length > 0) {
      return {
        environment: { ...environment }, runtimeRoot, runtimeAvailable: false, dllDirectories: [],
        fallbackReason: `ASR_GPU_RUNTIME_DLL_MISSING: ${missing.map(item => item.name).join(', ')}`,
      }
    }
    const directories = dllDirectories(runtimeRoot)
    return {
      environment: {
        ...environment,
        PATH: [...directories, environment.PATH ?? ''].join(path.delimiter),
        PERSONAL_WORKBENCH_ASR_GPU_RUNTIME: runtimeRoot,
      },
      runtimeRoot,
      runtimeAvailable: true,
      dllDirectories: directories,
      fallbackReason: null,
    }
  }

  async diagnose(): Promise<AsrGpuRuntimeDiagnostics> {
    const parentPath = process.env.PATH
    const launch = this.workerLaunch()
    const runtimeManifest = launch.runtimeRoot === null ? null : manifest(launch.runtimeRoot)
    const declared = runtimeManifest?.dlls ?? []
    const dlls: AsrGpuDllStatus[] = declared.length > 0
      ? declared.map(item => {
        const fullPath = launch.runtimeRoot === null ? '' : path.join(launch.runtimeRoot, String(item.relative_path ?? ''))
        const exists = fullPath.length > 0 && existsSync(fullPath)
        const size = exists ? statSync(fullPath).size : null
        return {
          name: String(item.name ?? path.basename(fullPath)), path: fullPath, exists, size_bytes: size,
          sha256: typeof item.sha256 === 'string' ? item.sha256 : null,
        }
      })
      : (launch.runtimeRoot === null ? [] : requiredDllPaths(launch.runtimeRoot).map(item => ({
        name: item.name, path: item.path, exists: existsSync(item.path), size_bytes: existsSync(item.path) ? statSync(item.path).size : null, sha256: null,
      })))
    let gpuName: string | null = null
    let driver: string | null = null
    let memory: number | null = null
    let cudaDriver: string | null = null
    const executable = nvidiaSmi()
    if (executable !== null) {
      const gpu = await runProcess(executable, ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 10_000 })
      if (gpu.exitCode === 0) ({ name: gpuName, driver, memory } = parseGpuRow(gpu.stdout))
      const summary = await runProcess(executable, [], { timeoutMs: 10_000 })
      cudaDriver = /CUDA(?:\s+UMD)?\s+Version:\s*([0-9.]+)/iu.exec(`${summary.stdout}\n${summary.stderr}`)?.[1] ?? null
    }
    const selectedDevice = PATHS.asrDevice === 'cpu' || !launch.runtimeAvailable ? 'cpu' : 'cuda'
    return {
      status: launch.runtimeAvailable && gpuName !== null ? 'available' : launch.runtimeAvailable ? 'error' : 'unavailable',
      checked_at: new Date().toISOString(), gpu_name: gpuName, driver_version: driver, cuda_driver_version: cudaDriver,
      gpu_memory_total_mb: memory, gpu_runtime_root: launch.runtimeRoot,
      runtime_versions: {
        cuda_runtime: packageVersion(runtimeManifest, 'nvidia-cuda-runtime-cu12'),
        cublas: packageVersion(runtimeManifest, 'nvidia-cublas-cu12'),
        cudnn: packageVersion(runtimeManifest, 'nvidia-cudnn-cu12'),
      },
      dlls, python: PATHS.asrPython, model_path: PATHS.asrModelPath,
      requested_device: PATHS.asrDevice, selected_device: selectedDevice,
      selected_compute_type: selectedDevice === 'cuda' ? PATHS.asrComputeType : 'int8',
      fallback_reason: selectedDevice === 'cpu' && PATHS.asrDevice !== 'cpu' ? launch.fallbackReason ?? 'NVIDIA_GPU_NOT_DETECTED' : null,
      fallback_validation: launch.runtimeRoot === null ? null : fallbackValidation(launch.runtimeRoot),
      benchmark: launch.runtimeRoot === null ? null : benchmark(launch.runtimeRoot),
      process_path_unchanged: process.env.PATH === parentPath,
    }
  }
}
