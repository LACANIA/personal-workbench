import path from 'node:path'
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { PATHS } from '../config.ts'

function pathKey(value: string): string {
  return path.resolve(value).replaceAll('/', '\\').toLowerCase()
}

export interface MediaCleanupResult {
  removed: string[]
  retained: string[]
}

export interface MediaTempEntry {
  relative_path: string
  size_bytes: number
}

export interface MediaTempPreview {
  root: string
  files: MediaTempEntry[]
  total_bytes: number
}

export class MediaCleanupService {
  async cleanupCompletedUrlDownload(outputDirectory: string, sourcePath: string): Promise<MediaCleanupResult> {
    const canonicalDirectory = await realpath(outputDirectory)
    const canonicalSource = await realpath(sourcePath)
    if (pathKey(path.dirname(canonicalSource)) !== pathKey(canonicalDirectory)) throw new Error('MEDIA_CLEANUP_PATH_DENIED')
    const sourceName = path.basename(canonicalSource)
    if (!/^source(?:\.[^.]+)*\.(?:mp4|mkv|mov|webm|m4a|mp3|wav|flac)$/iu.test(sourceName)) {
      throw new Error('MEDIA_CLEANUP_PATH_DENIED')
    }

    const removed: string[] = []
    const retained: string[] = []
    for (const name of await readdir(canonicalDirectory)) {
      const candidate = path.join(canonicalDirectory, name)
      const disposable = /^source(?:\.[^.]+)*\.(?:mp4|mkv|mov|webm|m4a|mp3|wav|flac|part|ytdl)$/iu.test(name)
        || name === '.asr-audio-16k.wav'
      if (!disposable) {
        retained.push(candidate)
        continue
      }
      await rm(candidate, { force: true })
      removed.push(candidate)
    }
    return { removed, retained }
  }

  async previewRuntimeTemp(): Promise<MediaTempPreview> {
    const configuredRoot = path.join(PATHS.myAgentRoot, 'runtime', 'media', 'temp')
    await mkdir(configuredRoot, { recursive: true })
    const canonicalRoot = await realpath(configuredRoot)
    const files: MediaTempEntry[] = []
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        const key = pathKey(absolute)
        if (!key.startsWith(`${pathKey(canonicalRoot)}\\`)) throw new Error('MEDIA_TEMP_CLEANUP_PATH_DENIED')
        if (entry.isSymbolicLink()) throw new Error('MEDIA_TEMP_CLEANUP_REPARSE_POINT_DENIED')
        if (entry.isDirectory()) { await visit(absolute); continue }
        if (!entry.isFile()) continue
        if (entry.name === '.gitkeep') continue
        const info = await lstat(absolute)
        files.push({ relative_path: path.relative(canonicalRoot, absolute), size_bytes: info.size })
      }
    }
    await visit(canonicalRoot)
    files.sort((left, right) => left.relative_path.localeCompare(right.relative_path))
    return { root: canonicalRoot, files, total_bytes: files.reduce((sum, item) => sum + item.size_bytes, 0) }
  }

  async cleanupRuntimeTemp(confirmed: boolean): Promise<MediaCleanupResult & { total_bytes: number }> {
    if (confirmed !== true) throw new Error('MEDIA_TEMP_CLEANUP_CONFIRMATION_REQUIRED')
    const preview = await this.previewRuntimeTemp()
    const removed: string[] = []
    for (const entry of preview.files) {
      const absolute = path.resolve(preview.root, entry.relative_path)
      if (!pathKey(absolute).startsWith(`${pathKey(preview.root)}\\`)) throw new Error('MEDIA_TEMP_CLEANUP_PATH_DENIED')
      await rm(absolute, { force: true })
      removed.push(absolute)
    }
    for (const entry of await readdir(preview.root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await rm(path.join(preview.root, entry.name), { recursive: true, force: true })
    }
    return { removed, retained: [], total_bytes: preview.total_bytes }
  }
}
