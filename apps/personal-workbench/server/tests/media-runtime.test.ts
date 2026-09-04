import { existsSync } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { MediaCleanupService } from '../src/video/cleanup.ts'
import { MediaToolService, normalizeVideoUrl, ytDlpCompatibilityArgs } from '../src/video/media-tools.ts'

const EVIDENCE_ROOT = process.env.PERSONAL_WORKBENCH_MEDIA_FIXTURE_ROOT ?? path.join(PATHS.appRoot, 'server', 'fixtures', 'optional-media-integration')
const SPEECH_AUDIO = path.join(EVIDENCE_ROOT, 'step28-speech.wav')
const SPEECH_VIDEO = path.join(EVIDENCE_ROOT, 'step28-no-subtitle.mp4')
const HAS_MEDIA_INTEGRATION = existsSync(SPEECH_AUDIO) && existsSync(SPEECH_VIDEO)
  && PATHS.ffmpegExecutable !== null && PATHS.ffprobeExecutable !== null
  && PATHS.ytdlpExecutable !== null && PATHS.asrPython !== null && PATHS.asrModelPath !== null
const mediaDescribe = describe.skipIf(!HAS_MEDIA_INTEGRATION)

mediaDescribe('STEP-28 media runtime components and URL policy', () => {
  const media = new MediaToolService()

  it('detects the project-local yt-dlp executable', () => expect(media.capabilities().downloader).toMatchObject({ available: true }))
  it('detects the project-local FFmpeg executable', () => expect(media.capabilities().ffmpeg).toMatchObject({ available: true }))
  it('detects the project-local ffprobe executable', () => expect(media.capabilities().ffprobe).toMatchObject({ available: true }))
  it('detects the isolated ASR runtime and model', () => expect(media.capabilities().asr).toMatchObject({ available: true, device: 'auto' }))
  it('reports the configured embedding runtime while the retrieval layer retains local-hash fallback', () => {
    expect(media.capabilities().embedding).toMatchObject({
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      dimensions: 1024,
    })
    expect(media.capabilities().embedding.diagnostic).toContain('Ollama Embedding')
  })
  it('returns actual tool versions from a runtime recheck', async () => {
    const status = await media.diagnose()
    expect(status.downloader.version).toContain('2026.08.19')
    expect(status.ffmpeg.version).toContain('ffmpeg version 6.0')
    expect(status.ffprobe.version).toContain('ffprobe version 6.0')
  })

  it('normalizes the previously rejected Bilibili share URL', () => {
    expect(normalizeVideoUrl('https://www.bilibili.com/video/BV1YpQUBpEbL/?share_source=copy_web')).toBe('https://www.bilibili.com/video/BV1YpQUBpEbL/')
  })
  it('uses the fixed Edge transport compatibility target only for Bilibili URLs', () => {
    expect(ytDlpCompatibilityArgs('https://www.bilibili.com/video/BV1YpQUBpEbL/')).toEqual(['--impersonate', 'edge-101:windows-10'])
    expect(ytDlpCompatibilityArgs('https://example.test/video')).toEqual([])
  })
  it('preserves only a valid Bilibili part selector', () => expect(normalizeVideoUrl('https://www.bilibili.com/video/BV1abc/?p=2&spm_id_from=333')).toContain('?p=2'))
  it('preserves required query values for generic HTTPS sources', () => expect(normalizeVideoUrl('https://example.test/media?id=7')).toContain('?id=7'))
  it('rejects URL userinfo', () => expect(() => normalizeVideoUrl('https://user:secret@example.test/video')).toThrow('INVALID_VIDEO_URL'))
  it('rejects unsupported schemes', () => expect(() => normalizeVideoUrl('file:///C:/video.mp4')).toThrow('INVALID_VIDEO_URL'))
  it('rejects insecure remote HTTP', () => expect(() => normalizeVideoUrl('http://example.test/video')).toThrow('VIDEO_URL_HTTPS_REQUIRED'))
  it('allows loopback HTTP for controlled tests', () => expect(normalizeVideoUrl('http://127.0.0.1:8080/video')).toContain('127.0.0.1'))
  it('rejects NUL in local media input', () => expect(() => media.sanitizedInput('audio', 'x\0.wav')).toThrow('INVALID_VIDEO_INPUT'))
})

mediaDescribe('STEP-28 media probe, subtitle priority and ASR', () => {
  const media = new MediaToolService()
  let root = ''
  let sidecarVideo = ''

  beforeAll(async () => {
    root = await mkdtemp(path.join(PATHS.appRoot, 'data', 'step28-media-test-'))
    sidecarVideo = path.join(root, 'sidecar.mp4')
    await copyFile(SPEECH_VIDEO, sidecarVideo)
    await writeFile(path.join(root, 'sidecar.srt'), '1\n00:00:00,000 --> 00:00:02,000\nSidecar subtitle wins.\n', 'utf8')
  })

  afterAll(async () => {
    const resolved = path.resolve(root)
    const allowed = path.resolve(PATHS.appRoot, 'data') + path.sep
    if (resolved.startsWith(allowed)) await rm(resolved, { recursive: true, force: true })
  })

  it('reads deterministic ffprobe metadata', async () => {
    const probe = await media.probeMedia(SPEECH_VIDEO)
    expect(probe.duration_seconds).toBeGreaterThan(7)
    expect(probe.video_codec).toBe('h264')
    expect(probe.audio_codec).toBe('aac')
  })
  it('counts media streams without model inference', async () => {
    const probe = await media.probeMedia(SPEECH_VIDEO)
    expect(probe.audio_streams).toBe(1)
    expect(probe.subtitle_streams).toBe(0)
  })
  it('uses a sidecar subtitle before ASR for permanently allowed media', async () => {
    const result = await media.acquire('local_video', sidecarVideo, path.join(root, 'sidecar-output'))
    expect(result.transcriptSource).toBe('sidecar_subtitle')
    expect(result.subtitlePath).toBe(path.join(root, 'sidecar.srt'))
  })
  it('uses an explicitly supplied subtitle as user_subtitle', async () => {
    const subtitle = path.join(root, 'sidecar.srt')
    const result = await media.acquire('subtitle', subtitle, path.join(root, 'subtitle-output'), { authorizedPath: subtitle })
    expect(result.transcriptSource).toBe('user_subtitle')
    expect(result.mediaProbe).toBeNull()
  })
  it('transcribes a local audio file with the isolated worker', async () => {
    const output = path.join(root, 'audio-output')
    const result = await media.acquire('audio', SPEECH_AUDIO, output, { authorizedPath: SPEECH_AUDIO })
    expect(result.transcriptSource).toBe('local_asr')
    expect(result.asr?.segments.length).toBeGreaterThan(0)
    expect(result.asr).toMatchObject({ resolved_device: 'cuda', compute_type: 'float16', fallback_used: false })
  }, 60_000)
  it('records sampled GPU memory in the worker result', async () => {
    const output = path.join(root, 'gpu-sampling-output')
    const result = await media.acquire('audio', SPEECH_AUDIO, output, { authorizedPath: SPEECH_AUDIO })
    expect(result.asr?.gpu_sampling).toMatchObject({ available: true, sample_semantics: 'whole_gpu_sampled' })
    expect(result.asr?.gpu_sampling?.peak_vram_mb).toBeGreaterThan(0)
  }, 60_000)
  it('creates an SRT transcript with timestamps', async () => {
    const output = path.join(root, 'srt-output')
    const result = await media.acquire('audio', SPEECH_AUDIO, output, { authorizedPath: SPEECH_AUDIO })
    expect(await readFile(result.subtitlePath, 'utf8')).toContain('00:00:00,000 -->')
  }, 60_000)
  it('removes the normalized temporary audio after ASR', async () => {
    const output = path.join(root, 'cleanup-output')
    await media.acquire('audio', SPEECH_AUDIO, output, { authorizedPath: SPEECH_AUDIO })
    await expect(access(path.join(output, '.asr-audio-16k.wav'))).rejects.toThrow()
  }, 60_000)
  it('cleans downloaded media while retaining transcript evidence', async () => {
    const output = path.join(root, 'url-cleanup-output')
    await mkdir(output, { recursive: true })
    const source = path.join(output, 'source.mp4')
    const evidence = path.join(output, 'source-subtitle.srt')
    await writeFile(source, 'media')
    await writeFile(path.join(output, 'source.f140.m4a'), 'audio')
    await writeFile(evidence, 'subtitle')
    const result = await new MediaCleanupService().cleanupCompletedUrlDownload(output, source)
    expect(result.removed).toHaveLength(2)
    await expect(access(source)).rejects.toThrow()
    await expect(access(evidence)).resolves.toBeUndefined()
  })
  it('runs the no-subtitle local video through ffprobe and ASR', async () => {
    const output = path.join(root, 'video-output')
    const result = await media.acquire('local_video', SPEECH_VIDEO, output, { authorizedPath: SPEECH_VIDEO })
    expect(result).toMatchObject({ transcriptSource: 'local_asr', mediaProbe: { subtitle_streams: 0, video_codec: 'h264' } })
  }, 60_000)
})

mediaDescribe('STEP-28 source and database boundaries', () => {
  it('runs child processes with shell disabled', async () => expect(await readFile(path.join(PATHS.appRoot, 'server', 'src', 'process.ts'), 'utf8')).toContain('shell: false'))
  it('never requests browser cookies in the downloader', async () => expect(await readFile(path.join(PATHS.appRoot, 'server', 'src', 'video', 'media-tools.ts'), 'utf8')).not.toContain('--cookies-from-browser'))
  it('disables playlist expansion in metadata and download paths', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'video', 'media-tools.ts'), 'utf8')
    expect(source.match(/--no-playlist/gu)?.length).toBeGreaterThanOrEqual(2)
  })
  it('uses Portable Config v4 media fields', () => {
    expect(PATHS.asrDevice).toBe('auto')
    expect(PATHS.asrGpuRuntimeRoot).toContain('gpu-runtime')
    expect(PATHS.asrGpuAvailable).toBe(true)
    expect(PATHS.ytdlpExecutable).toContain('runtime\\media\\bin\\yt-dlp.exe')
  })
  it('keeps Workbench SQLite integrity and foreign keys valid', () => {
    const database = new WorkbenchDatabase()
    try {
      expect((database.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
      expect(database.db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
    } finally { database.close() }
  })
})
