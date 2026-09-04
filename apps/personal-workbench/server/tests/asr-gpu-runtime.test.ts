import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AsrBenchmarkReport } from '../../shared/contracts/index.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { runProcess } from '../src/process.ts'
import { AsrDiagnosticsService } from '../src/video/asr-diagnostics.ts'
import { MediaToolService } from '../src/video/media-tools.ts'

const STEP28_ROOT = process.env.PERSONAL_WORKBENCH_MEDIA_FIXTURE_ROOT ?? path.join(PATHS.appRoot, 'server', 'fixtures', 'optional-media-integration')
const STEP29_ROOT = process.env.PERSONAL_WORKBENCH_GPU_EVIDENCE_ROOT ?? path.join(PATHS.appRoot, 'server', 'fixtures', 'optional-gpu-integration')
const SPEECH_AUDIO = path.join(STEP28_ROOT, 'step28-speech.wav')
const HAS_GPU_INTEGRATION = existsSync(SPEECH_AUDIO) && existsSync(path.join(STEP29_ROOT, 'gpu-smoke-test.json'))
  && PATHS.asrPython !== null && PATHS.asrModelPath !== null && PATHS.asrGpuRuntimeRoot !== null
  && existsSync(PATHS.asrGpuRuntimeRoot)
const gpuDescribe = describe.skipIf(!HAS_GPU_INTEGRATION)

gpuDescribe('STEP-29 isolated GPU runtime', () => {
  const diagnostics = new AsrDiagnosticsService()
  const originalPath = process.env.PATH

  it('detects the project-local GPU runtime', () => expect(diagnostics.workerLaunch()).toMatchObject({ runtimeAvailable: true }))
  it('detects cuBLAS 12', () => expect(existsSync(path.join(PATHS.asrGpuRuntimeRoot!, 'python-packages', 'nvidia', 'cublas', 'bin', 'cublas64_12.dll'))).toBe(true))
  it('detects cuDNN 9', () => expect(existsSync(path.join(PATHS.asrGpuRuntimeRoot!, 'python-packages', 'nvidia', 'cudnn', 'bin', 'cudnn64_9.dll'))).toBe(true))
  it('creates a subprocess-only PATH overlay', () => {
    const launch = diagnostics.workerLaunch()
    expect(launch.environment.PATH).toContain('gpu-runtime')
    expect(launch.environment.PATH).not.toBe(originalPath)
    expect(process.env.PATH).toBe(originalPath)
  })
  it('selects CUDA float16 for the current auto configuration', async () => {
    const report = await diagnostics.diagnose()
    expect(report).toMatchObject({ status: 'available', selected_device: 'cuda', selected_compute_type: 'float16', process_path_unchanged: true })
    expect(report.gpu_name).toContain('RTX 5070')
  })
  it('returns required runtime versions and DLL metadata', async () => {
    const report = await diagnostics.diagnose()
    expect(report.runtime_versions).toEqual({ cuda_runtime: '12.4.127', cublas: '12.4.5.8', cudnn: '9.5.0.50' })
    expect(report.dlls.length).toBeGreaterThanOrEqual(12)
    expect(report.dlls.every(item => item.exists && item.size_bytes! > 0 && item.sha256 !== null)).toBe(true)
  })
  it('loads the persisted CPU/GPU benchmark model', async () => {
    const report = await diagnostics.diagnose()
    expect(report.benchmark?.summary.sample_count).toBe(3)
    expect(report.benchmark?.summary.mean_speedup).toBeGreaterThan(1)
  })
})

gpuDescribe('STEP-29 worker fallback and benchmark evidence', () => {
  let root = ''
  beforeAll(async () => { root = await mkdtemp(path.join(PATHS.appRoot, 'data', 'step29-asr-test-')) })
  afterAll(async () => {
    const allowed = `${path.resolve(PATHS.appRoot, 'data')}${path.sep}`
    if (path.resolve(root).startsWith(allowed)) await rm(root, { recursive: true, force: true })
  })

  it('falls back to CPU int8 when the task-local GPU runtime is unavailable', async () => {
    const output = path.join(root, 'fallback.srt')
    const worker = path.join(PATHS.appRoot, 'server', 'workers', 'transcribe.py')
    const result = await runProcess(PATHS.asrPython!, [
      worker, '--model', PATHS.asrModelPath!, '--input', SPEECH_AUDIO, '--output', output,
      '--device', 'auto', '--compute-type', 'float16', '--cpu-compute-type', 'int8',
      '--gpu-runtime-root', path.join(root, 'missing-runtime'),
    ], { timeoutMs: 60_000 })
    const payload = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? '{}') as Record<string, unknown>
    expect(result.exitCode).toBe(0)
    expect(payload).toMatchObject({ resolved_device: 'cpu', compute_type: 'int8', fallback_used: true })
    expect(String(payload.fallback_reason)).toContain('missing-runtime')
  }, 60_000)
  it('keeps compute type selection explicit', () => {
    expect(PATHS.asrComputeType).toBe('float16')
    const smoke = JSON.parse(readFileSync(path.join(STEP29_ROOT, 'gpu-smoke-test.json'), 'utf8')) as { tests: Array<Record<string, unknown>> }
    expect(smoke.tests).toContainEqual(expect.objectContaining({ compute_type: 'int8_float16', status: 'error' }))
  })
  it('calculates reproducible RTF values', () => {
    const report = JSON.parse(readFileSync(path.join(PATHS.asrGpuRuntimeRoot!, 'last-benchmark.json'), 'utf8')) as AsrBenchmarkReport
    for (const row of report.comparisons) {
      expect(row.cpu.rtf).toBeCloseTo(row.cpu.asr_time_seconds / row.cpu.media_duration_seconds, 5)
      expect(row.gpu.rtf).toBeCloseTo(row.gpu.asr_time_seconds / row.gpu.media_duration_seconds, 5)
    }
  })
  it('records transcript quality separately from speed', () => {
    const report = JSON.parse(readFileSync(path.join(PATHS.asrGpuRuntimeRoot!, 'last-benchmark.json'), 'utf8')) as AsrBenchmarkReport
    expect(report.comparisons.every(row => typeof row.exact_match === 'boolean' && typeof row.character_difference_ratio === 'number')).toBe(true)
  })
})

gpuDescribe('STEP-29 Workbench, review and isolation boundaries', () => {
  it('exposes a token-protected diagnostics API', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8')
    expect(source).toContain('/api/video/asr/diagnostics')
    expect(source.indexOf('if (!authenticate(request))')).toBeLessThan(source.indexOf("url.pathname === '/api/video/asr/diagnostics'"))
  })
  it('shows ASR device and fallback reason on Video Job details', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'web', 'src', 'pages', 'VideoPage.tsx'), 'utf8')
    expect(source).toContain('ASR Device')
    expect(source).toContain('fallback_reason')
  })
  it('does not call ASR for a user SRT input', async () => {
    const media = new MediaToolService()
    const subtitle = path.join(STEP28_ROOT, 'step28-speech-auto.srt')
    const output = path.join(PATHS.appRoot, 'data', `step29-srt-${Date.now()}`)
    try {
      const result = await media.acquire('subtitle', subtitle, output, { authorizedPath: subtitle })
      expect(result).toMatchObject({ transcriptSource: 'user_subtitle', asr: null })
    } finally { await rm(output, { recursive: true, force: true }) }
  })
  it('keeps the human review gate and staged memory state', async () => {
    const service = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'video', 'service.ts'), 'utf8')
    const repository = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'video', 'repository.ts'), 'utf8')
    expect(service).toContain("status: 'awaiting_review'")
    expect(repository).toContain("DEFAULT 'staged'")
  })
  it('keeps Ollama configuration unchanged and loopback-only', () => {
    expect(PATHS.ollamaEndpoint).toBe('http://127.0.0.1:11434')
    expect(PATHS.modelName).toBe('qwen3:8b')
  })
  it('uses shell=false for every Workbench child process', async () => expect(await readFile(path.join(PATHS.appRoot, 'server', 'src', 'process.ts'), 'utf8')).toContain('shell: false'))
  it('keeps Workbench SQLite integrity and foreign keys valid', () => {
    const database = new WorkbenchDatabase()
    try {
      expect((database.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
      expect(database.db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
    } finally { database.close() }
  })
})
