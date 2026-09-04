import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PATHS } from '../src/config.ts'
import { FrameOcrService } from '../src/video/frame-ocr.ts'
import { runProcess } from '../src/process.ts'
import { parseSubtitle, renderSrt, segmentSubtitle } from '../src/video/subtitle.ts'
import { TranscriptCorrectionService } from '../src/video/transcript-correction.ts'

const roots: string[] = []
const runtimeIt = PATHS.asrPython !== null && PATHS.ffmpegExecutable !== null ? it : it.skip

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
})

function iqAsrFixture() {
  return parseSubtitle('1\n00:00:00,000 --> 00:00:04,000\nIQ型号可以写成余显寒数的形式。\n\n2\n00:00:04,000 --> 00:00:08,000\nA乘以Ca2πft加φ，其中向位决定波形位置。', '.srt', 'zh')
}

describe('STEP-32 ASR/OCR multimodal correction', () => {
  it('uses OCR-recognized canonical IQ terminology ahead of ASR aliases', async () => {
    const corrected = await new TranscriptCorrectionService().correct(iqAsrFixture(), [{
      index: 0, timestamp_ms: 0, text: 'IQ信号 cos 余弦函数 相位', confidence: 0.99,
    }])
    const output = corrected.parsed.cues.map(cue => cue.text).join('\n')
    expect(output).toContain('IQ信号')
    expect(output).toContain('余弦函数')
    expect(output).toContain('cos2πft')
    expect(output).toContain('相位')
    expect(output).not.toMatch(/IQ型号|余显寒数|Ca2πft|向位/u)
    expect(corrected.changes.filter(change => change.source === 'ocr').length).toBeGreaterThanOrEqual(4)
    expect(corrected.transcript_source).toBe('asr_ocr_fusion')
  })

  it('keeps audio and subtitle inputs in the same controlled dictionary path without inventing OCR text', async () => {
    const corrected = await new TranscriptCorrectionService().correct(iqAsrFixture(), [])
    expect(corrected.transcript_source).toBe('domain_dictionary')
    expect(corrected.parsed.cues.map(cue => cue.text).join('\n')).toContain('cos2πft')
    expect(corrected.parsed.cues.map(cue => cue.text).join('\n')).not.toContain('OCR 识别出的额外句子')
  })

  it('writes a separate corrected SRT and segments only corrected cue text', async () => {
    const corrected = await new TranscriptCorrectionService().correct(iqAsrFixture(), [{ index: 0, timestamp_ms: 0, text: 'cos 余弦函数 相位 IQ信号' }])
    const srt = renderSrt(corrected.parsed)
    expect(srt).toContain('00:00:00,000 --> 00:00:04,000')
    expect(segmentSubtitle(corrected.parsed)[0]?.text).toContain('余弦函数')
    expect(srt).not.toContain('余显寒数')
  })

  runtimeIt('has a local frame OCR worker and never requires a browser or cloud service', () => {
    const capability = new FrameOcrService().capabilities()
    expect(capability).toMatchObject({ available: true, engine: 'rapidocr_onnxruntime' })
    expect(PATHS.asrPython).toContain('runtime\\media\\asr\\.venv')
  })

  runtimeIt('extracts local key frames and stores OCR output only in the task output directory', async () => {
    if (PATHS.ffmpegExecutable === null) throw new Error('FFMPEG_UNAVAILABLE')
    const parent = path.join(PATHS.appRoot, 'data')
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(path.join(parent, 'step32-ocr-test-'))
    roots.push(root)
    const source = path.join(root, 'fixture.mp4')
    const generated = await runProcess(PATHS.ffmpegExecutable, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=640x360:d=16', '-c:v', 'mpeg4', source,
    ], { timeoutMs: 60_000 })
    expect(generated.exitCode).toBe(0)
    const output = path.join(root, 'output')
    const result = await new FrameOcrService().extract(source, output, {
      format: 'mov,mp4,m4a,3gp,3g2,mj2', duration_seconds: 16, size_bytes: null, video_codec: 'mpeg4', audio_codec: null,
      width: 640, height: 360, fps: 25, audio_streams: 0, subtitle_streams: 0,
    })
    expect(result.status).toBe('completed')
    expect(result.frame_count).toBeGreaterThan(0)
    expect(result.output_path).toContain(path.join(root, 'output'))
    await expect(access(result.output_path!)).resolves.toBeUndefined()
  }, 120_000)

  it('does not run frame OCR for an audio-only input', async () => {
    const result = await new FrameOcrService().extract('E:\\fixture.wav', 'E:\\ignored', {
      format: 'wav', duration_seconds: 1, size_bytes: 1, video_codec: null, audio_codec: 'pcm_s16le', width: null, height: null,
      fps: null, audio_streams: 1, subtitle_streams: 0,
    })
    expect(result).toMatchObject({ status: 'not_applicable', frame_count: 0 })
  })

  it('records correction stages before segmentation and prevents raw parsed subtitles from becoming knowledge segments', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'video', 'service.ts'), 'utf8')
    expect(source).toContain("this.update(job.id, taskId, 'frame_extract'")
    expect(source).toContain("ocr: { stage: 'extracting'")
    expect(source).toContain("this.update(job.id, taskId, 'fusion'")
    expect(source).toContain("this.update(job.id, taskId, 'term_correction'")
    expect(source).toContain('segmentSubtitle(correction.parsed)')
    expect(source).not.toContain('segmentSubtitle(parsed)')
  })
})
