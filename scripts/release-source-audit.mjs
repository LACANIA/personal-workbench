import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv.includes('--staged')
  ? 'staged'
  : process.argv.includes('--tracked')
    ? 'tracked'
    : 'candidate'

const gitArgs = mode === 'staged'
  ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
  : mode === 'tracked'
    ? ['ls-files', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z']

let names
try {
  names = execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
} catch {
  console.error('release-source-audit: 当前目录尚未初始化为 Git 仓库。')
  process.exit(2)
}

const normalized = [...new Set(names.map(name => name.replaceAll('\\', '/')))].sort()
const blockedRoots = [
  'personal-inbox/',
  'runtime/',
  'tmp/',
  'validation-logs/',
  'validation-fixtures/',
  'screenshots/',
  'releases/',
  'reports/',
  'launchers/',
  'apps/personal-workbench/backup/',
  'apps/personal-workbench/cache/',
  'apps/personal-workbench/config/',
  'apps/personal-workbench/data/',
  'apps/personal-workbench/logs/',
  'apps/personal-workbench/output/',
  'apps/personal-workbench/personal-inbox/',
  'apps/personal-workbench/releases/',
  'apps/personal-workbench/runtime/',
  'apps/personal-workbench/screenshots/',
  'apps/personal-workbench/tmp/',
  'memory/backups/',
  'memory/ingest/audit/',
  'memory/ingest/manifests/',
  'memory/tests/runtime/',
]
const blockedExtensions = new Set([
  '.db', '.sqlite', '.sqlite3', '.log', '.zip', '.exe', '.msi', '.dll', '.pdb',
  '.onnx', '.bin', '.gguf', '.safetensors', '.pfx', '.p12', '.pem', '.key',
])
const warningLimit = 95 * 1024 * 1024
const failureLimit = 100 * 1024 * 1024
const maxTextBytes = 20 * 1024 * 1024
const findings = []
const warnings = []

const developmentRoot = ['E:', '\\AI-Agent-Lab'].join('')
const developmentUser = ['32', '377'].join('')
const installedMarker = ['step39', '-installed'].join('')
const textRules = [
  ['development-root', text => text.replaceAll('\\\\', '\\').replaceAll('/', '\\').includes(developmentRoot)],
  ['development-user', text => text.replaceAll('\\\\', '\\').replaceAll('/', '\\').includes(`C:\\Users\\${developmentUser}`)],
  ['installed-validation-marker', text => text.includes(installedMarker)],
  ['github-token', text => new RegExp(`(?:gh${'p_'}|github${'_pat_'})[A-Za-z0-9_]{20,}`, 'u').test(text)],
  ['api-token', text => new RegExp(`s${'k-'}[A-Za-z0-9_-]{20,}`, 'u').test(text)],
  ['private-key', text => text.includes(['-----BEGIN ', 'PRIVATE KEY-----'].join(''))],
  ['bearer-token', text => new RegExp(`Authoriz(?:ation)?\\s*[:=]\\s*["']?Bearer\\s+[A-Za-z0-9._~-]{16,}`, 'iu').test(text)],
  ['credential-assignment', text => new RegExp(`(?:api[_-]?key|access[_-]?token|password|secret)\\s*[:=]\\s*["'][^"'\\r\\n]{16,}["']`, 'iu').test(text)],
]

function report(kind, file, rule, detail = '') {
  const entry = { kind, file, rule, detail }
  if (kind === 'warning') warnings.push(entry)
  else findings.push(entry)
}

for (const relative of normalized) {
  const lower = relative.toLowerCase()
  const absolute = path.resolve(repoRoot, relative)
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    report('error', relative, 'unreadable')
    continue
  }
  if (!stat.isFile()) continue

  if (blockedRoots.some(root => lower.startsWith(root))) report('error', relative, 'blocked-path')
  if (/(^|\/)(?:node_modules|__pycache__|\.venv|venv)(?:\/|$)/iu.test(lower)) report('error', relative, 'generated-directory')
  if (blockedExtensions.has(path.extname(lower))) report('error', relative, 'blocked-extension')
  if (lower.endsWith('/local-config.json') || lower === 'apps/personal-workbench/local-config.json') {
    report('error', relative, 'local-config')
  }
  if (stat.size > failureLimit) report('error', relative, 'file-over-100-mib', `${stat.size} bytes`)
  else if (stat.size > warningLimit) report('warning', relative, 'file-over-95-mib', `${stat.size} bytes`)

  if (stat.size > maxTextBytes) continue
  const buffer = readFileSync(absolute)
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) continue
  const text = buffer.toString('utf8')
  for (const [rule, matches] of textRules) {
    if (matches(text)) report('error', relative, rule)
  }
}

for (const warning of warnings) console.warn(`WARN ${warning.rule}: ${warning.file}${warning.detail ? ` (${warning.detail})` : ''}`)
for (const finding of findings) console.error(`FAIL ${finding.rule}: ${finding.file}${finding.detail ? ` (${finding.detail})` : ''}`)
console.log(`release-source-audit: mode=${mode} files=${normalized.length} warnings=${warnings.length} failures=${findings.length}`)
process.exit(findings.length === 0 ? 0 : 1)
