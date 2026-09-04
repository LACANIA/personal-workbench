import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MediaProbeResult, VideoProcessLogEntry } from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { runProcess } from '../process.ts'
import type { OcrTextEvidence } from './transcript-correction.ts'

type LogSink = (entry: VideoProcessLogEntry) => void

export interface FrameOcrExecution {
  status: 'completed' | 'not_applicable' | 'unavailable'
  engine: 'rapidocr_onnxruntime' | null
  frame_interval_seconds: number
  frame_count: number
  text_frame_count: number
  output_path: string | null
  duration_ms: number
  frames: OcrTextEvidence[]
  reason: string | null
}

interface WorkerOutput {
  status: 'ok'
  engine: string
  duration_ms: number
  frames: OcrTextEvidence[]
}

function log(sink: LogSink | undefined, stage: string, message: string, durationMs?: number): void {
  sink?.({ timestamp: new Date().toISOString(), stage, level: 'info', message, ...(durationMs === undefined ? {} : { duration_ms: Math.round(durationMs) }) })
}

function safeWorkerPayload(value: unknown): WorkerOutput {
  if (value === null || typeof value !== 'object') throw new Error('OCR_WORKER_INVALID_OUTPUT')
  const row = value as Record<string, unknown>
  if (row.status !== 'ok' || row.engine !== 'rapidocr_onnxruntime' || !Array.isArray(row.frames)) throw new Error('OCR_WORKER_INVALID_OUTPUT')
  const frames = row.frames.map((frame, index) => {
    if (frame === null || typeof frame !== 'object') throw new Error('OCR_WORKER_INVALID_FRAME')
    const item = frame as Record<string, unknown>
    if (!Number.isInteger(item.index) || typeof item.timestamp_ms !== 'number' || typeof item.text !== 'string' || item.text.length > 24_000) throw new Error('OCR_WORKER_INVALID_FRAME')
    return { index: Number(item.index ?? index), timestamp_ms: Math.max(0, Math.trunc(Number(item.timestamp_ms))), text: item.text.trim(), confidence: typeof item.confidence === 'number' ? item.confidence : null }
  })
  return { status: 'ok', engine: row.engine, duration_ms: Number(row.duration_ms ?? 0), frames }
}

export class FrameOcrService {
  readonly frameIntervalSeconds = 15
  readonly maximumFrames = 24

  capabilities(): { available: boolean; python: string | null; engine: string | null; reason: string | null } {
    const worker = path.join(PATHS.appRoot, 'server', 'workers', 'ocr.py')
    const available = PATHS.asrPython !== null && existsSync(PATHS.asrPython) && existsSync(worker)
    return { available, python: available ? PATHS.asrPython : null, engine: available ? 'rapidocr_onnxruntime' : null, reason: available ? null : '本机 OCR 运行环境尚未配置。' }
  }

  async extract(sourcePath: string | null, outputDirectory: string, probe: MediaProbeResult | null, onLog?: LogSink): Promise<FrameOcrExecution> {
    if (sourcePath === null || probe?.video_codec === null) {
      return { status: 'not_applicable', engine: null, frame_interval_seconds: this.frameIntervalSeconds, frame_count: 0, text_frame_count: 0, output_path: null, duration_ms: 0, frames: [], reason: '当前输入没有可抽取的视频画面。' }
    }
    const capability = this.capabilities()
    if (!capability.available || PATHS.asrPython === null) {
      return { status: 'unavailable', engine: null, frame_interval_seconds: this.frameIntervalSeconds, frame_count: 0, text_frame_count: 0, output_path: null, duration_ms: 0, frames: [], reason: capability.reason }
    }
    const ffmpeg = PATHS.ffmpegExecutable
    if (ffmpeg === null || !existsSync(ffmpeg)) throw new Error('FFMPEG_UNAVAILABLE')
    const started = performance.now()
    const frameDirectory = path.join(outputDirectory, 'ocr-frames')
    await mkdir(frameDirectory, { recursive: true })
    log(onLog, 'frame_extract', '正在抽取视频关键帧，用于识别字幕、演示页、公式和代码画面。')
    const outputPattern = path.join(frameDirectory, 'frame-%04d.jpg')
    const extraction = await runProcess(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
      '-vf', `fps=1/${this.frameIntervalSeconds}`, '-frames:v', String(this.maximumFrames), '-q:v', '2', outputPattern,
    ], { cwd: outputDirectory, timeoutMs: 10 * 60_000 })
    if (extraction.exitCode !== 0) throw new Error(`OCR_FRAME_EXTRACTION_FAILED:${`${extraction.stderr}\n${extraction.stdout}`.slice(0, 800)}`)
    const names = (await readdir(frameDirectory)).filter(name => /^frame-\d{4}\.jpg$/u.test(name)).sort()
    if (names.length === 0) throw new Error('OCR_FRAME_EXTRACTION_EMPTY')
    const manifestPath = path.join(outputDirectory, 'ocr-frame-manifest.json')
    await writeFile(manifestPath, `${JSON.stringify({ schema: 'personal-workbench.ocr-frame-manifest.v1', frame_interval_seconds: this.frameIntervalSeconds, frames: names.map((name, index) => ({ index, file: name, timestamp_ms: index * this.frameIntervalSeconds * 1000 })) }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    log(onLog, 'frame_extract', `关键帧抽取完成，共 ${names.length} 帧。`, performance.now() - started)

    const outputPath = path.join(outputDirectory, 'ocr-results.json')
    log(onLog, 'ocr', '正在对关键帧进行本机 OCR 识别。')
    const worker = path.join(PATHS.appRoot, 'server', 'workers', 'ocr.py')
    const result = await runProcess(PATHS.asrPython, [worker, '--input-dir', frameDirectory, '--manifest', manifestPath, '--output', outputPath], { cwd: outputDirectory, timeoutMs: 20 * 60_000 })
    let payload: WorkerOutput
    try { payload = safeWorkerPayload(JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? '{}')) } catch (error) {
      throw new Error(`OCR_FAILED:${error instanceof Error ? error.message : String(error)}`)
    }
    if (result.exitCode !== 0 || !existsSync(outputPath)) throw new Error(`OCR_FAILED:${`${result.stderr}\n${result.stdout}`.slice(0, 800)}`)
    const resultBody = JSON.parse(await readFile(outputPath, 'utf8')) as WorkerOutput
    const parsed = safeWorkerPayload(resultBody)
    const duration = performance.now() - started
    log(onLog, 'ocr', `本机 OCR 完成，在 ${parsed.frames.filter(frame => frame.text.length > 0).length} 个画面中检测到文字。`, duration)
    return {
      status: 'completed', engine: 'rapidocr_onnxruntime', frame_interval_seconds: this.frameIntervalSeconds,
      frame_count: names.length, text_frame_count: parsed.frames.filter(frame => frame.text.length > 0).length,
      output_path: outputPath, duration_ms: Number(duration.toFixed(3)), frames: parsed.frames, reason: null,
    }
  }
}
