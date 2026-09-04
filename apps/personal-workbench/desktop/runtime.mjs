import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

const REQUIRED_DIRECTORIES = ['data', 'config', 'logs', 'runtime', 'cache', 'output', 'backup']

export function isLoopbackUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  } catch {
    return false
  }
}

export function parseServerReadyLine(line) {
  let value
  try { value = JSON.parse(line) } catch { return null }
  if (value?.type !== 'workbench.ready' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null
  if (typeof value.token !== 'string' || value.token.length < 32 || !isLoopbackUrl(value.url)) return null
  return value
}

export function sanitizeLogValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text
    .replace(/[A-Za-z]:\\[^\s"']+/gu, '[local-path]')
    .replace(/(?:token|authorization)[=:]\s*[^\s,}]+/giu, '$1=[redacted]')
    .slice(0, 2000)
}

export async function prepareDataRoot(dataRoot) {
  const resolved = path.resolve(dataRoot)
  for (const directory of REQUIRED_DIRECTORIES) await mkdir(path.join(resolved, directory), { recursive: true })
  return resolved
}

export async function clearStaleServerState(runtimeStatePath) {
  let state
  try { state = JSON.parse(await readFile(runtimeStatePath, 'utf8')) } catch { return false }
  const pid = Number(state?.pid)
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); return false } catch { /* stale state */ }
  }
  await rm(runtimeStatePath, { force: true })
  return true
}

export async function backupBeforeMigration(dataRoot, nextVersion) {
  const statePath = path.join(dataRoot, 'config', 'install-state.json')
  let previous = null
  try { previous = JSON.parse(await readFile(statePath, 'utf8')) } catch { /* first run */ }
  const databasePath = path.join(dataRoot, 'data', 'personal-workbench.db')
  let backupPath = null
  if (previous?.version && previous.version !== nextVersion) {
    try {
      await stat(databasePath)
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      const backupDirectory = path.join(dataRoot, 'backup', `pre-upgrade-${stamp}`)
      await mkdir(backupDirectory, { recursive: true })
      backupPath = path.join(backupDirectory, 'personal-workbench.db')
      await copyFile(databasePath, backupPath)
      await writeFile(path.join(backupDirectory, 'install-state.json'), `${JSON.stringify(previous, null, 2)}\n`, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const temporary = `${statePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: nextVersion, schema_version: 1, updated_at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  await rename(temporary, statePath)
  return backupPath
}

export async function restoreMigrationBackup(dataRoot, backupPath) {
  if (typeof backupPath !== 'string' || backupPath.length === 0) return false
  const databasePath = path.join(dataRoot, 'data', 'personal-workbench.db')
  await copyFile(backupPath, databasePath)
  const previousState = path.join(path.dirname(backupPath), 'install-state.json')
  try {
    await copyFile(previousState, path.join(dataRoot, 'config', 'install-state.json'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return true
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function createDiagnosticsZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replaceAll('\\', '/'), 'utf8')
    const source = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const body = deflateRawSync(source, { level: 9 })
    const checksum = crc32(source)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(source.length, 22); local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(8, 10); header.writeUInt32LE(checksum, 16)
    header.writeUInt32LE(body.length, 20); header.writeUInt32LE(source.length, 24); header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    offset += local.length + name.length + body.length
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...central, end])
}

export async function appendRotatingLog(logPath, event, maximumBytes = 2 * 1024 * 1024) {
  try {
    const info = await stat(logPath)
    if (info.size >= maximumBytes) {
      await rm(`${logPath}.1`, { force: true })
      await rename(logPath, `${logPath}.1`)
    }
  } catch { /* a missing log is expected on first run */ }
  await mkdir(path.dirname(logPath), { recursive: true })
  const line = `${JSON.stringify({ at: new Date().toISOString(), event: sanitizeLogValue(event) })}\n`
  const current = await readFile(logPath, 'utf8').catch(() => '')
  await writeFile(logPath, `${current}${line}`, 'utf8')
}

export function validateExternalUrl(value) {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('EXTERNAL_URL_DENIED')
  return parsed.toString()
}

export function modelIsAllowed(model) {
  return ['qwen3:8b', 'qwen3-embedding:0.6b', 'qwen2.5-coder:7b'].includes(model)
}
