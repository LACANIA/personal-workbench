import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { PATHS } from '../config.ts'

function key(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function unsafeSyntax(value: string): boolean {
  const win = value.replaceAll('/', '\\')
  const withoutDrive = /^[A-Za-z]:\\/u.test(win) ? win.slice(2) : win
  return win.startsWith('\\\\') || /^\\\\[?.]\\/u.test(win) || withoutDrive.includes(':')
}

export async function loadAllowedRoots(): Promise<string[]> {
  const parsed = JSON.parse((await readFile(PATHS.policy, 'utf8')).replace(/^\uFEFF/u, '')) as { allowedRoots?: unknown }
  if (!Array.isArray(parsed.allowedRoots) || parsed.allowedRoots.length === 0) throw new Error('PATH_POLICY_INVALID')
  const roots: string[] = []
  for (const item of parsed.allowedRoots) {
    if (typeof item !== 'string' || unsafeSyntax(item)) throw new Error('PATH_POLICY_INVALID')
    const canonical = await realpath(path.resolve(item))
    if (!(await stat(canonical)).isDirectory()) throw new Error('PATH_POLICY_INVALID')
    roots.push(canonical)
  }
  return roots
}

export async function assertAllowedExisting(input: string, expected: 'file' | 'directory' | 'any' = 'any'): Promise<string> {
  if (typeof input !== 'string' || input.trim().length === 0 || input.includes('\0') || unsafeSyntax(input)) {
    throw new Error('PATH_POLICY_DENIED')
  }
  const canonical = await realpath(path.resolve(input))
  const targetKey = key(canonical)
  const roots = await loadAllowedRoots()
  if (!roots.some(root => targetKey === key(root) || targetKey.startsWith(`${key(root)}${path.sep}`))) {
    throw new Error('PATH_POLICY_DENIED')
  }
  const info = await stat(canonical)
  if (expected === 'file' && !info.isFile()) throw new Error('PATH_TYPE_MISMATCH')
  if (expected === 'directory' && !info.isDirectory()) throw new Error('PATH_TYPE_MISMATCH')
  return canonical
}
