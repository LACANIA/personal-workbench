import { existsSync, statfsSync } from 'node:fs'
import os from 'node:os'
import type { FirstRunSmokeResult, FirstRunStatus, PortableWorkbenchConfig } from '../../../shared/contracts/index.ts'
import { LOCAL_CONFIG, PATHS } from '../config.ts'
import { runProcess } from '../process.ts'
import { saveLocalConfig } from '../portable-config.ts'

const MODELS = [
  { id: 'qwen3:8b', role: 'general' as const, required: true },
  { id: 'qwen3-embedding:0.6b', role: 'embedding' as const, required: true },
  { id: 'qwen2.5-coder:7b', role: 'code' as const, required: false },
]

function modelMatches(installed: Set<string>, required: string): boolean {
  const base = required.includes(':') ? required : `${required}:latest`
  return installed.has(required) || installed.has(base) || installed.has(required.replace(/:latest$/u, ''))
}

export class FirstRunService {
  async status(): Promise<FirstRunStatus> {
    let ollamaRunning = false
    const installedModels = new Set<string>()
    try {
      const response = await fetch(new URL('/api/tags', `${LOCAL_CONFIG.ollama_endpoint}/`), { signal: AbortSignal.timeout(3000) })
      if (response.ok) {
        ollamaRunning = true
        const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> }
        for (const model of payload.models ?? []) installedModels.add(String(model.name ?? model.model ?? ''))
      }
    } catch { /* degraded mode */ }
    const executableDetected = LOCAL_CONFIG.ollama_executable !== null && existsSync(LOCAL_CONFIG.ollama_executable)
    const gpuProbe = await runProcess('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 3000 }).catch(() => null)
    const gpuLine = gpuProbe?.exitCode === 0 ? gpuProbe.stdout.trim().split(/\r?\n/u)[0] : undefined
    const [gpuName, gpuMemory] = gpuLine?.split(',').map(value => value.trim()) ?? []
    let diskFreeGb: number | null = null
    try { const disk = statfsSync(PATHS.dataRoot); diskFreeGb = Math.round((disk.bavail * disk.bsize / 1024 ** 3) * 10) / 10 } catch { /* unavailable */ }
    const checks: FirstRunStatus['checks'] = [
      { id: 'data_root', status: existsSync(PATHS.dataRoot) ? 'ok' : 'error', message: PATHS.dataRoot },
      { id: 'ollama', status: ollamaRunning ? 'ok' : 'warning', message: ollamaRunning ? '本地AI服务正在运行' : executableDetected ? 'Ollama已安装，当前没有运行' : '当前没有检测到Ollama' },
      { id: 'general_model', status: modelMatches(installedModels, 'qwen3:8b') ? 'ok' : 'warning', message: modelMatches(installedModels, 'qwen3:8b') ? '通用模型已准备' : '当前Ollama没有发现qwen3:8b' },
      { id: 'embedding_model', status: modelMatches(installedModels, 'qwen3-embedding:0.6b') ? 'ok' : 'warning', message: modelMatches(installedModels, 'qwen3-embedding:0.6b') ? '本地检索模型已准备' : '本地检索暂不可用' },
      { id: 'media', status: LOCAL_CONFIG.ffmpeg_executable !== null ? 'ok' : 'warning', message: LOCAL_CONFIG.ffmpeg_executable !== null ? '媒体工具可用' : '视频学习组件尚未安装' },
    ]
    return {
      required: !LOCAL_CONFIG.first_run_completed, completed: LOCAL_CONFIG.first_run_completed,
      config_path: PATHS.localConfig, detected: LOCAL_CONFIG, checks,
      system: {
        windows: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model ?? 'Unknown CPU', logical_cores: os.cpus().length,
        ram_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10, disk_free_gb: diskFreeGb,
        gpu: { available: gpuLine !== undefined, name: gpuName ?? null, vram_mb: gpuMemory === undefined ? null : Number(gpuMemory) },
      },
      ollama: { status: ollamaRunning ? 'running' : executableDetected ? 'installed_stopped' : 'not_detected', endpoint: LOCAL_CONFIG.ollama_endpoint, executable_detected: executableDetected },
      models: MODELS.map(model => ({ ...model, installed: modelMatches(installedModels, model.id) })),
      media_summary: {
        status: LOCAL_CONFIG.asr_gpu_available ? 'gpu' : LOCAL_CONFIG.asr_python !== null ? 'cpu' : 'not_installed',
        ffmpeg: LOCAL_CONFIG.ffmpeg_executable !== null, ytdlp: LOCAL_CONFIG.ytdlp_executable !== null,
        asr: LOCAL_CONFIG.asr_python !== null, ocr: LOCAL_CONFIG.asr_python !== null,
      },
      data_root: PATHS.dataRoot, desktop: PATHS.desktopMode,
    }
  }

  async smoke(): Promise<FirstRunSmokeResult> {
    const chat: FirstRunSmokeResult['chat'] = { ok: false, model: 'qwen3:8b', response: null, error: null }
    const embedding: FirstRunSmokeResult['embedding'] = { ok: false, model: 'qwen3-embedding:0.6b', dimensions: null, finite: false, error: null }
    try {
      const response = await fetch(new URL('/api/chat', `${LOCAL_CONFIG.ollama_endpoint}/`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ model: chat.model, stream: false, think: false, messages: [{ role: 'user', content: '只回复：QWEN3_LOCAL_OK' }] }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as { message?: { content?: string } }
      chat.response = value.message?.content?.trim().slice(0, 200) ?? null
      chat.ok = Boolean(chat.response)
    } catch (error) { chat.error = error instanceof Error ? error.message : String(error) }
    try {
      const response = await fetch(new URL('/api/embed', `${LOCAL_CONFIG.ollama_endpoint}/`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ model: embedding.model, input: 'Personal Workbench本地检索测试' }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json() as { embeddings?: number[][] }
      const vector = value.embeddings?.[0]
      embedding.dimensions = vector?.length ?? null
      embedding.finite = Array.isArray(vector) && vector.every(Number.isFinite)
      embedding.ok = embedding.dimensions === 1024 && embedding.finite
    } catch (error) { embedding.error = error instanceof Error ? error.message : String(error) }
    return { chat, embedding }
  }

  complete(overrides: Partial<PortableWorkbenchConfig> = {}): PortableWorkbenchConfig {
    const forbidden = ['config_version', 'first_run_completed']
    if (forbidden.some(key => Object.hasOwn(overrides, key))) throw new Error('FIRST_RUN_CONTROL_FIELD_DENIED')
    return saveLocalConfig(PATHS.localConfig, { ...LOCAL_CONFIG, ...overrides, first_run_completed: true })
  }
}
