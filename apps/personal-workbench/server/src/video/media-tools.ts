import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  MediaProbeResult,
  TranscriptSource,
  VideoCapabilityStatus,
  VideoInputType,
  VideoProcessLogEntry,
} from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { runProcess, type ProcessResult } from '../process.ts'
import { assertAllowedExisting } from '../security/path-policy.ts'
import { AsrDiagnosticsService } from './asr-diagnostics.ts'
import { FrameOcrService } from './frame-ocr.ts'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi'])
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.flac', '.webm'])
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.txt'])
const MAX_URL_DURATION_SECONDS = 3_600
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024
const BILIBILI_IMPERSONATE_TARGET = 'edge-101:windows-10'

type LogSink = (entry: VideoProcessLogEntry) => void

function executableStatus(value: string | null, label: string): { available: boolean; executable: string | null; reason: string | null } {
  const available = value !== null && existsSync(value)
  return { available, executable: available ? value : null, reason: available ? null : `${label} 未在 Portable Config 或 PATH 中找到。` }
}

function cleanProcessDetail(result: ProcessResult): string {
  return `${result.stderr}\n${result.stdout}`.replace(/(?<=cookie|token|authorization)[^\s]*/giu, '[redacted]').slice(0, 1200)
}

function processFailure(code: string, result: ProcessResult): Error {
  const detail = cleanProcessDetail(result)
  if (/login|sign in|cookies|authentication|members-only|private video/iu.test(detail)) return new Error(`VIDEO_AUTH_REQUIRED: ${detail}`)
  return new Error(`${code}: ${detail}`)
}

export function normalizeVideoUrl(raw: string): string {
  let parsed: URL
  try { parsed = new URL(raw.trim()) } catch { throw new Error('INVALID_VIDEO_URL') }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) {
    throw new Error('INVALID_VIDEO_URL')
  }
  if (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase())) throw new Error('VIDEO_URL_HTTPS_REQUIRED')
  if (parsed.hostname.toLowerCase().endsWith('bilibili.com')) {
    const part = parsed.searchParams.get('p')
    parsed.search = ''
    if (part !== null && /^\d{1,3}$/u.test(part)) parsed.searchParams.set('p', part)
  }
  return parsed.toString()
}

/**
 * Bilibili sometimes rejects the default HTTP client before any media is read.
 * This target only supplies a supported transport fingerprint; it never loads
 * browser profiles, cookies, credentials, or user-provided command text.
 */
export function ytDlpCompatibilityArgs(value: string): string[] {
  const hostname = new URL(normalizeVideoUrl(value)).hostname.toLowerCase()
  return hostname === 'b23.tv' || hostname.endsWith('.b23.tv') || hostname.endsWith('bilibili.com')
    ? ['--impersonate', BILIBILI_IMPERSONATE_TARGET]
    : []
}

function numeric(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function fps(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0 || value === '0/0') return null
  const [top, bottom = '1'] = value.split('/')
  const resolved = numeric(top) / numeric(bottom, 1)
  return Number.isFinite(resolved) && resolved > 0 ? Number(resolved.toFixed(3)) : null
}

export interface UrlMetadata {
  id: string
  title: string
  webpage_url: string
  extractor: string
  duration_seconds: number
  estimated_bytes: number | null
}

export interface AsrExecutionResult {
  engine: string
  requested_device: string
  resolved_device: string
  compute_type: string
  fallback_used: boolean
  fallback_reason: string | null
  language: string
  language_probability: number
  duration_ms: number
  segments: Array<{ start: number; end: number; text: string }>
  gpu_runtime: Record<string, unknown>
  gpu_sampling: {
    available: boolean
    sample_semantics: string
    sample_count: number
    baseline_vram_mb: number | null
    peak_vram_mb: number | null
    peak_delta_vram_mb: number | null
    peak_gpu_utilization_percent: number | null
  } | null
}

export interface AcquiredVideoInput {
  sourcePath: string | null
  subtitlePath: string
  sourceReference: string
  inputType: VideoInputType
  transcriptSource: TranscriptSource
  mediaProbe: MediaProbeResult | null
  urlMetadata: UrlMetadata | null
  asr: AsrExecutionResult | null
}

export class MediaToolService {
  constructor(readonly asrDiagnostics = new AsrDiagnosticsService(), readonly ocr = new FrameOcrService()) {}

  capabilities(): VideoCapabilityStatus {
    const asrAvailable = PATHS.asrPython !== null && PATHS.asrModelPath !== null && existsSync(PATHS.asrPython) && existsSync(PATHS.asrModelPath)
    const launch = this.asrDiagnostics.workerLaunch()
    const resolvedDevice = PATHS.asrDevice === 'cpu' || !launch.runtimeAvailable ? 'cpu' : 'cuda'
    return {
      downloader: executableStatus(PATHS.ytdlpExecutable, 'yt-dlp'),
      ffmpeg: executableStatus(PATHS.ffmpegExecutable, 'FFmpeg'),
      ffprobe: executableStatus(PATHS.ffprobeExecutable, 'ffprobe'),
      ocr: this.ocr.capabilities(),
      asr: {
        available: asrAvailable,
        python: asrAvailable ? PATHS.asrPython : null,
        model_path: asrAvailable ? PATHS.asrModelPath : null,
        device: PATHS.asrDevice,
        compute_type: PATHS.asrComputeType,
        resolved_device: resolvedDevice,
        gpu_runtime_available: launch.runtimeAvailable,
        gpu_runtime_root: launch.runtimeRoot,
        runtime_status: !asrAvailable ? 'error' : resolvedDevice === 'cuda' ? 'available' : 'fallback',
        reason: !asrAvailable ? '本机 ASR Python 或模型目录尚未配置。' : resolvedDevice === 'cpu' && PATHS.asrDevice !== 'cpu' ? launch.fallbackReason : null,
      },
      embedding: {
        available: true,
        provider: PATHS.embeddingProvider === 'ollama' ? 'ollama' : 'local-hash-v1',
        model: PATHS.embeddingModel ?? 'unicode-ngram-sha256',
        dimensions: PATHS.embeddingDimension,
        diagnostic: PATHS.embeddingProvider === 'ollama' ? '已配置本机 Ollama Embedding。' : '基础本地检索模式；当前不宣称语义 Embedding。',
      },
      accepted_inputs: ['url', 'local_video', 'subtitle', 'audio'],
    }
  }

  async diagnose(): Promise<VideoCapabilityStatus> {
    const status = this.capabilities()
    const probes: Array<[keyof Pick<VideoCapabilityStatus, 'downloader' | 'ffmpeg' | 'ffprobe'>, string | null, string[]]> = [
      ['downloader', PATHS.ytdlpExecutable, ['--version']],
      ['ffmpeg', PATHS.ffmpegExecutable, ['-version']],
      ['ffprobe', PATHS.ffprobeExecutable, ['-version']],
    ]
    for (const [key, executable, args] of probes) {
      if (executable === null || !existsSync(executable)) continue
      const result = await runProcess(executable, args, { timeoutMs: 10_000 })
      const firstLine = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).find(Boolean) ?? null
      status[key] = { ...status[key], available: result.exitCode === 0, version: firstLine, reason: result.exitCode === 0 ? null : cleanProcessDetail(result) }
    }
    const asr = await this.asrDiagnostics.diagnose()
    status.asr = {
      ...status.asr,
      resolved_device: asr.selected_device,
      gpu_runtime_available: asr.status === 'available',
      gpu_runtime_root: asr.gpu_runtime_root,
      runtime_status: asr.status === 'available' ? 'available' : status.asr.available ? 'fallback' : 'error',
      reason: asr.fallback_reason,
    }
    return status
  }

  sanitizedInput(type: VideoInputType, value: string): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096 || value.includes('\0')) throw new Error('INVALID_VIDEO_INPUT')
    if (type === 'url') return normalizeVideoUrl(value)
    return path.resolve(value.trim())
  }

  async probeUrl(value: string): Promise<UrlMetadata> {
    const executable = PATHS.ytdlpExecutable
    if (executable === null || !existsSync(executable)) throw new Error('VIDEO_DOWNLOADER_UNAVAILABLE')
    const url = normalizeVideoUrl(value)
    const result = await runProcess(executable, [...ytDlpCompatibilityArgs(url), '--simulate', '--dump-single-json', '--no-playlist', '--no-warnings', url], { timeoutMs: 120_000 })
    if (result.exitCode !== 0) throw processFailure('VIDEO_METADATA_PROBE_FAILED', result)
    let row: Record<string, unknown>
    try { row = JSON.parse(result.stdout) as Record<string, unknown> } catch { throw new Error('VIDEO_METADATA_INVALID') }
    const duration = numeric(row.duration)
    if (duration <= 0 || duration > MAX_URL_DURATION_SECONDS) throw new Error('VIDEO_DURATION_LIMIT_EXCEEDED')
    const size = numeric(row.filesize ?? row.filesize_approx, 0) || null
    if (size !== null && size > MAX_DOWNLOAD_BYTES) throw new Error('VIDEO_SIZE_LIMIT_EXCEEDED')
    return {
      id: String(row.id ?? ''), title: String(row.title ?? row.id ?? 'video').slice(0, 240),
      webpage_url: normalizeVideoUrl(String(row.webpage_url ?? url)), extractor: String(row.extractor_key ?? row.extractor ?? 'unknown'),
      duration_seconds: duration, estimated_bytes: size,
    }
  }

  async probeMedia(filePath: string): Promise<MediaProbeResult> {
    const executable = PATHS.ffprobeExecutable
    if (executable === null || !existsSync(executable)) throw new Error('FFPROBE_UNAVAILABLE')
    const result = await runProcess(executable, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], { timeoutMs: 60_000 })
    if (result.exitCode !== 0) throw processFailure('MEDIA_PROBE_FAILED', result)
    let parsed: { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> }
    try { parsed = JSON.parse(result.stdout) as typeof parsed } catch { throw new Error('MEDIA_PROBE_INVALID_JSON') }
    const streams = parsed.streams ?? []
    const video = streams.find(stream => stream.codec_type === 'video')
    const audio = streams.find(stream => stream.codec_type === 'audio')
    return {
      format: typeof parsed.format?.format_name === 'string' ? parsed.format.format_name : null,
      duration_seconds: numeric(parsed.format?.duration), size_bytes: numeric(parsed.format?.size, 0) || null,
      video_codec: typeof video?.codec_name === 'string' ? video.codec_name : null,
      audio_codec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
      width: video === undefined ? null : numeric(video.width, 0) || null,
      height: video === undefined ? null : numeric(video.height, 0) || null,
      fps: fps(video?.avg_frame_rate ?? video?.r_frame_rate),
      audio_streams: streams.filter(stream => stream.codec_type === 'audio').length,
      subtitle_streams: streams.filter(stream => stream.codec_type === 'subtitle').length,
    }
  }

  async acquire(
    type: VideoInputType,
    value: string,
    outputDirectory: string,
    options: { authorizedPath?: string; language?: string; onLog?: LogSink } = {},
  ): Promise<AcquiredVideoInput> {
    await mkdir(outputDirectory, { recursive: true })
    const log = (stage: string, message: string, durationMs?: number, level: VideoProcessLogEntry['level'] = 'info'): void => {
      options.onLog?.({ timestamp: new Date().toISOString(), stage, level, message, ...(durationMs === undefined ? {} : { duration_ms: Math.round(durationMs) }) })
    }
    if (type === 'subtitle') {
      const subtitle = options.authorizedPath ?? await assertAllowedExisting(value, 'file')
      if (!SUBTITLE_EXTENSIONS.has(path.extname(subtitle).toLowerCase())) throw new Error('UNSUPPORTED_SUBTITLE_EXTENSION')
      log('transcribing', '使用用户明确提供的字幕文件。')
      return { sourcePath: null, subtitlePath: subtitle, sourceReference: subtitle, inputType: type, transcriptSource: 'user_subtitle', mediaProbe: null, urlMetadata: null, asr: null }
    }

    let sourcePath: string
    let sourceReference: string
    let metadata: UrlMetadata | null = null
    if (type === 'url') {
      const started = performance.now()
      metadata = await this.probeUrl(value)
      log('inspecting', `已读取公开视频元数据：${metadata.title}`, performance.now() - started)
      sourceReference = metadata.webpage_url
      sourcePath = await this.download(metadata.webpage_url, outputDirectory, log)
    } else {
      sourcePath = options.authorizedPath ?? await assertAllowedExisting(value, 'file')
      sourceReference = sourcePath
      const extension = path.extname(sourcePath).toLowerCase()
      if (type === 'local_video' && !VIDEO_EXTENSIONS.has(extension)) throw new Error('UNSUPPORTED_VIDEO_EXTENSION')
      if (type === 'audio' && !AUDIO_EXTENSIONS.has(extension)) throw new Error('UNSUPPORTED_AUDIO_EXTENSION')
    }

    const probeStarted = performance.now()
    const mediaProbe = await this.probeMedia(sourcePath)
    log('probing', `媒体探测完成：${mediaProbe.duration_seconds.toFixed(2)} 秒，音轨 ${mediaProbe.audio_streams}，字幕轨 ${mediaProbe.subtitle_streams}。`, performance.now() - probeStarted)

    if (type === 'local_video' && options.authorizedPath === undefined) {
      const sidecar = await this.findSidecar(sourcePath)
      if (sidecar !== null) {
        log('transcribing', '使用同目录侧挂字幕。')
        return { sourcePath, subtitlePath: sidecar, sourceReference, inputType: type, transcriptSource: 'sidecar_subtitle', mediaProbe, urlMetadata: metadata, asr: null }
      }
    }
    const downloadedSubtitle = await this.findDownloadedSubtitle(outputDirectory)
    if (downloadedSubtitle !== null) {
      log('transcribing', '使用下载得到的字幕轨。')
      return { sourcePath, subtitlePath: downloadedSubtitle, sourceReference, inputType: type, transcriptSource: 'embedded_subtitle', mediaProbe, urlMetadata: metadata, asr: null }
    }
    if (mediaProbe.subtitle_streams > 0) {
      const embedded = await this.extractEmbeddedSubtitle(sourcePath, outputDirectory)
      if (embedded !== null) {
        log('transcribing', '使用媒体内嵌字幕轨。')
        return { sourcePath, subtitlePath: embedded, sourceReference, inputType: type, transcriptSource: 'embedded_subtitle', mediaProbe, urlMetadata: metadata, asr: null }
      }
    }
    const asr = await this.transcribe(sourcePath, outputDirectory, options.language, log)
    return { sourcePath, subtitlePath: path.join(outputDirectory, 'generated-transcript.srt'), sourceReference, inputType: type, transcriptSource: 'local_asr', mediaProbe, urlMetadata: metadata, asr }
  }

  async copySubtitleForAudit(subtitlePath: string, outputDirectory: string): Promise<string> {
    const destination = path.join(outputDirectory, `source-subtitle${path.extname(subtitlePath).toLowerCase()}`)
    if (path.resolve(subtitlePath).toLowerCase() !== path.resolve(destination).toLowerCase()) await copyFile(subtitlePath, destination)
    return destination
  }

  async readSubtitle(subtitlePath: string): Promise<string> {
    const data = await readFile(subtitlePath)
    if (data.includes(0) || data.byteLength > 5 * 1024 * 1024) throw new Error('INVALID_SUBTITLE_CONTENT')
    return data.toString('utf8')
  }

  private async download(url: string, outputDirectory: string, log: (stage: string, message: string, durationMs?: number, level?: VideoProcessLogEntry['level']) => void): Promise<string> {
    const executable = PATHS.ytdlpExecutable
    if (executable === null || !existsSync(executable)) throw new Error('VIDEO_DOWNLOADER_UNAVAILABLE')
    const started = performance.now()
    const template = path.join(outputDirectory, 'source.%(ext)s')
    const ffmpegLocation = PATHS.ffmpegExecutable === null ? [] : ['--ffmpeg-location', PATHS.ffmpegExecutable]
    const result = await runProcess(executable, [
      ...ytDlpCompatibilityArgs(url),
      '--no-playlist', '--restrict-filenames', '--no-write-comments', '--no-write-info-json',
      '--write-subs', '--write-auto-subs', '--sub-langs', 'zh.*,en.*', '--convert-subs', 'srt',
      '--format', 'bestvideo[height<=720]+bestaudio/best[height<=720]/bestaudio/best', '--merge-output-format', 'mp4',
      '--max-filesize', String(MAX_DOWNLOAD_BYTES), '--match-filter', `duration <= ${MAX_URL_DURATION_SECONDS}`,
      ...ffmpegLocation, '-o', template, url,
    ], { cwd: outputDirectory, timeoutMs: 30 * 60_000 })
    if (result.exitCode !== 0) throw processFailure('VIDEO_DOWNLOAD_FAILED', result)
    const entries = await readdir(outputDirectory)
    const mediaName = entries.find(name => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()) && !/\.f\d+\./u.test(name))
      ?? entries.find(name => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()))
      ?? entries.find(name => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    if (mediaName === undefined) throw new Error('VIDEO_DOWNLOAD_OUTPUT_MISSING')
    log('acquiring', `媒体下载完成：${mediaName}`, performance.now() - started)
    return path.join(outputDirectory, mediaName)
  }

  private async findDownloadedSubtitle(directory: string): Promise<string | null> {
    const entries = await readdir(directory)
    const name = entries.find(entry => SUBTITLE_EXTENSIONS.has(path.extname(entry).toLowerCase()) && !entry.startsWith('generated-transcript'))
    return name === undefined ? null : path.join(directory, name)
  }

  private async findSidecar(videoPath: string): Promise<string | null> {
    const base = videoPath.slice(0, -path.extname(videoPath).length)
    for (const extension of ['.srt', '.vtt', '.txt']) {
      const candidate = `${base}${extension}`
      if (existsSync(candidate)) return assertAllowedExisting(candidate, 'file')
    }
    return null
  }

  private async extractEmbeddedSubtitle(sourcePath: string, outputDirectory: string): Promise<string | null> {
    const executable = PATHS.ffmpegExecutable
    if (executable === null || !existsSync(executable)) return null
    const output = path.join(outputDirectory, 'embedded-subtitle.srt')
    const result = await runProcess(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-map', '0:s:0', '-c:s', 'srt', output], { timeoutMs: 120_000 })
    return result.exitCode === 0 && existsSync(output) ? output : null
  }

  private async transcribe(sourcePath: string, outputDirectory: string, language: string | undefined, log: (stage: string, message: string, durationMs?: number, level?: VideoProcessLogEntry['level']) => void): Promise<AsrExecutionResult> {
    const capabilities = this.capabilities()
    if (!capabilities.asr.available || PATHS.asrPython === null || PATHS.asrModelPath === null) throw new Error('ASR_RUNTIME_MISSING')
    const ffmpeg = PATHS.ffmpegExecutable
    if (ffmpeg === null || !existsSync(ffmpeg)) throw new Error('FFMPEG_UNAVAILABLE')
    const normalizedAudio = path.join(outputDirectory, '.asr-audio-16k.wav')
    const output = path.join(outputDirectory, 'generated-transcript.srt')
    const normalizeStarted = performance.now()
    const normalized = await runProcess(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', normalizedAudio], { timeoutMs: 10 * 60_000 })
    if (normalized.exitCode !== 0 || !existsSync(normalizedAudio)) throw processFailure('AUDIO_EXTRACTION_FAILED', normalized)
    log('audio_extract', '音轨已转换为本机 ASR 输入格式。', performance.now() - normalizeStarted)
    const worker = path.join(PATHS.appRoot, 'server', 'workers', 'transcribe.py')
    const launch = this.asrDiagnostics.workerLaunch()
    const args = [worker, '--model', PATHS.asrModelPath, '--input', normalizedAudio, '--output', output, '--device', PATHS.asrDevice, '--compute-type', PATHS.asrComputeType, '--cpu-compute-type', 'int8']
    if (launch.runtimeRoot !== null) args.push('--gpu-runtime-root', launch.runtimeRoot)
    if (language !== undefined && language !== 'auto' && language.trim().length > 0) args.push('--language', language.trim())
    const started = performance.now()
    try {
      const result = await runProcess(PATHS.asrPython, args, { cwd: outputDirectory, env: launch.environment, timeoutMs: 60 * 60_000 })
      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? '{}') as Record<string, unknown> } catch { /* mapped below */ }
      if (result.exitCode !== 0 || payload.status !== 'ok' || !existsSync(output)) {
        const code = typeof payload.error_code === 'string' ? payload.error_code : 'ASR_FAILED'
        throw new Error(`${code}: ${String(payload.message ?? cleanProcessDetail(result)).slice(0, 800)}`)
      }
      const execution = payload as unknown as AsrExecutionResult
      log('transcribing', `本机 ASR 完成：${execution.resolved_device}/${execution.compute_type}${execution.fallback_used ? `，GPU 回退原因：${execution.fallback_reason ?? '未知'}` : ''}。`, performance.now() - started, execution.fallback_used ? 'warning' : 'info')
      return execution
    } finally {
      await rm(normalizedAudio, { force: true })
    }
  }
}
