import { opendir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { assertAllowedExisting } from '../security/path-policy.ts'

const SKIP_NAMES = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'cache', 'caches', 'tmp', 'temp', '__pycache__'])

export interface AssetInventoryResult {
  status: 'OK'
  canonicalRoot: string
  fileCount: number
  directoryCount: number
  totalBytes: number
  extensionDistribution: { extension: string; count: number }[]
  recentFiles: { path: string; size: number; modifiedAt: string }[]
  largeFiles: { path: string; size: number }[]
  skippedCount: number
  skippedPreview: string[]
  durationMs: number
}

export async function collectAssetInventory(inputPath: string, options: { authorizedRoot?: string } = {}): Promise<AssetInventoryResult> {
  const started = performance.now()
  const root = options.authorizedRoot === undefined
    ? await assertAllowedExisting(inputPath, 'directory')
    : await realpath(options.authorizedRoot)
  if (options.authorizedRoot !== undefined && path.normalize(await realpath(inputPath)).toLowerCase() !== path.normalize(root).toLowerCase()) {
    throw new Error('PATH_POLICY_DENIED')
  }
  if (!(await stat(root)).isDirectory()) throw new Error('PATH_TYPE_MISMATCH')
  let fileCount = 0
  let directoryCount = 1
  let totalBytes = 0
  const extensionCounts = new Map<string, number>()
  const recent: { path: string; size: number; modifiedAt: string }[] = []
  const large: { path: string; size: number }[] = []
  const skipped: string[] = []
  const stack = [root]
  const deadline = performance.now() + 15000
  while (stack.length > 0) {
    if (performance.now() > deadline) throw new Error('ASSET_SCAN_TIMEOUT')
    if (fileCount + directoryCount > 100_000) throw new Error('ASSET_SCAN_TOO_BROAD')
    const current = stack.pop()!
    const directory = await opendir(current)
    for await (const entry of directory) {
      const fullPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) { skipped.push(fullPath); continue }
      if (entry.isDirectory()) {
        if (SKIP_NAMES.has(entry.name)) { skipped.push(fullPath); continue }
        const canonical = await realpath(fullPath)
        if (!canonical.toLowerCase().startsWith(root.toLowerCase() + path.sep) && canonical.toLowerCase() !== root.toLowerCase()) {
          skipped.push(fullPath)
          continue
        }
        directoryCount += 1
        stack.push(canonical)
      } else if (entry.isFile()) {
        const info = await stat(fullPath)
        fileCount += 1
        totalBytes += info.size
        const ext = path.extname(entry.name).toLowerCase() || '[无扩展名]'
        extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1)
        recent.push({ path: fullPath, size: info.size, modifiedAt: info.mtime.toISOString() })
        large.push({ path: fullPath, size: info.size })
      }
    }
  }
  recent.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  large.sort((a, b) => b.size - a.size)
  return {
    status: 'OK', canonicalRoot: root, fileCount, directoryCount, totalBytes,
    extensionDistribution: [...extensionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([extension, count]) => ({ extension, count })),
    recentFiles: recent.slice(0, 10), largeFiles: large.slice(0, 10),
    skippedCount: skipped.length, skippedPreview: skipped.slice(0, 20),
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
  }
}
