import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { BackupManifest } from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return hash.digest('hex')
}

function stamp(): string { return new Date().toISOString().replace(/[:.]/gu, '').replace('Z', 'Z') }

export class BackupManager {
  constructor(readonly backupRoot = PATHS.backups) {}

  async create(): Promise<BackupManifest> {
    const id = `${stamp()}-${randomUUID().slice(0, 8)}`
    const directory = path.join(this.backupRoot, id)
    await mkdir(directory, { recursive: true })
    const sources = [
      { role: 'workbench' as const, source: PATHS.workbenchDb, name: 'personal-workbench.db' },
      { role: 'research-memory' as const, source: PATHS.memoryProduction, name: 'research-memory.db' },
    ]
    const files: BackupManifest['files'] = []
    for (const item of sources) {
      if (!existsSync(item.source)) continue
      const source = new DatabaseSync(item.source, { readOnly: true })
      const destination = path.join(directory, item.name)
      try { await backup(source, destination) } finally { source.close() }
      const verifier = new DatabaseSync(destination, { readOnly: true })
      let integrity = 'unknown'
      try {
        integrity = String((verifier.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check)
        const foreignKeys = verifier.prepare('PRAGMA foreign_key_check').all()
        if (foreignKeys.length > 0) integrity = `foreign_key_errors:${foreignKeys.length}`
      } finally { verifier.close() }
      const info = await stat(destination)
      files.push({ role: item.role, source_path: item.source, backup_path: destination, sha256: await sha256(destination), size_bytes: info.size, integrity_check: integrity })
    }
    const manifestPath = path.join(directory, 'backup-manifest.json')
    const manifest: BackupManifest = {
      id, created_at: new Date().toISOString(), backup_root: this.backupRoot, files,
      manifest_path: manifestPath, verified: files.length > 0 && files.every(file => file.integrity_check === 'ok'),
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return manifest
  }

  async list(): Promise<BackupManifest[]> {
    if (!existsSync(this.backupRoot)) return []
    const entries = await readdir(this.backupRoot, { withFileTypes: true })
    const manifests: BackupManifest[] = []
    for (const entry of entries.filter(item => item.isDirectory())) {
      const manifestPath = path.join(this.backupRoot, entry.name, 'backup-manifest.json')
      try { manifests.push(JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest) } catch { /* Ignore incomplete backup directories. */ }
    }
    return manifests.sort((left, right) => right.created_at.localeCompare(left.created_at))
  }

  async verify(id: string): Promise<BackupManifest> {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(id)) throw new Error('INVALID_BACKUP_ID')
    const manifestPath = path.join(this.backupRoot, id, 'backup-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest
    for (const file of manifest.files) {
      if (!path.resolve(file.backup_path).startsWith(path.resolve(this.backupRoot) + path.sep)) throw new Error('BACKUP_PATH_DENIED')
      if (await sha256(file.backup_path) !== file.sha256) throw new Error('BACKUP_HASH_MISMATCH')
      const database = new DatabaseSync(file.backup_path, { readOnly: true })
      try {
        const integrity = (database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
        if (integrity !== 'ok' || database.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('BACKUP_INTEGRITY_FAILED')
      } finally { database.close() }
    }
    return { ...manifest, verified: true }
  }
}
