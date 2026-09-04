import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const repoRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const policyModule = await import('../plugins/personal-safe-fs/src/policy.js')
const operationsModule = await import('../plugins/personal-safe-fs/src/operations.js')
const { PathPolicy } = policyModule
const { personalGlob, personalGrep, personalRead } = operationsModule

let testRoot
let fixtureRoot
let junctionPath
let outsideRoot
let outsideFile
let policyPath
const ripgrepShim = path.join(repoRoot, 'node_modules', '@vscode', 'ripgrep')
const marker = 'STEP09_DENY_MARKER_8B1701'
const exec = {
  signal: new AbortController().signal,
  agent: { session: { header: { cwd: repoRoot } } },
}

let policy

before(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), 'personal-safe-fs-'))
  fixtureRoot = path.join(repoRoot, 'tests', '.step09-search-fixture')
  junctionPath = path.join(repoRoot, 'tests', '.step09-outside-junction')
  outsideRoot = path.join(testRoot, 'outside')
  outsideFile = path.join(outsideRoot, 'deny.txt')
  policyPath = path.join(testRoot, 'personal-path-policy.yaml')
  const rgPath = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['rg'], { encoding: 'utf8' })
    .split(/\r?\n/u).find(Boolean)
  await mkdir(ripgrepShim, { recursive: true })
  await writeFile(path.join(ripgrepShim, 'package.json'), `${JSON.stringify({ name: '@vscode/ripgrep', type: 'module', exports: './index.js' })}\n`, 'utf8')
  await writeFile(path.join(ripgrepShim, 'index.js'), `export const rgPath = ${JSON.stringify(rgPath)}\n`, 'utf8')
  await writeFile(policyPath, `${JSON.stringify({ allowedRoots: [repoRoot] }, null, 2)}\n`, 'utf8')
  policy = await PathPolicy.load(policyPath)
  await mkdir(outsideRoot, { recursive: true })
  await writeFile(outsideFile, marker, 'utf8')
  await rm(fixtureRoot, { recursive: true, force: true })
  await mkdir(fixtureRoot, { recursive: true })
  const writes = []
  for (let index = 0; index < 130; index += 1) {
    const name = `fixture-${String(index).padStart(3, '0')}.txt`
    writes.push(writeFile(path.join(fixtureRoot, name), 'MATCH_LINE\nMATCH_LINE\nMATCH_LINE\nONE_PER_FILE\n', 'utf8'))
  }
  await Promise.all(writes)
})

after(async () => {
  await unlink(junctionPath).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  await rm(fixtureRoot, { recursive: true, force: true })
  await rm(testRoot, { recursive: true, force: true })
  await rm(ripgrepShim, { recursive: true, force: true })
})

test('policy contains only the requested canonical root', () => {
  assert.deepEqual(policy.allowedRoots.map(value => value.toLowerCase()), [repoRoot.toLowerCase()])
})

test('personal_read returns bounded UTF-8 text with canonical source lines', async () => {
  const result = await personalRead(policy, { file_path: path.join(repoRoot, 'README.md'), offset: 1, limit: 20 }, exec)
  assert.equal(result.status, 'OK')
  assert.match(result.canonicalFilePath, /README\.md$/iu)
  assert.equal(result.startLine, 1)
  assert.ok(result.endLine <= 20)
  assert.equal(result.truncated, true)
  assert.match(result.content, /Personal Workbench/u)
})

test('case and separator variants resolve to the same allowed file on Windows', async () => {
  const variant = path.join(repoRoot, 'README.md').replaceAll('\\', '/').toUpperCase()
  const result = await policy.resolveExisting(variant, repoRoot, 'file')
  assert.match(result.canonicalPath, /README\.md$/iu)
})

test('outside absolute path and traversal are denied with PATH_POLICY_DENIED', async () => {
  await assert.rejects(
    policy.resolveExisting(outsideFile, repoRoot, 'file'),
    error => error.code === 'PATH_POLICY_DENIED' && !error.message.includes(marker),
  )
  await assert.rejects(
    policy.resolveExisting(path.relative(repoRoot, outsideFile), repoRoot, 'file'),
    error => error.code === 'PATH_POLICY_DENIED' && !error.message.includes(marker),
  )
})

test('UNC and device namespace path forms are denied before filesystem access', async () => {
  await assert.rejects(
    policy.resolveExisting('\\\\localhost\\share\\README.md', repoRoot, 'file'),
    error => error.code === 'PATH_POLICY_DENIED',
  )
  await assert.rejects(
    policy.resolveExisting(`\\\\?\\${path.join(repoRoot, 'README.md')}`, repoRoot, 'file'),
    error => error.code === 'PATH_POLICY_DENIED',
  )
})

test('junction inside the allowlist cannot cross to an outside target', async () => {
  await unlink(junctionPath).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  await symlink(outsideRoot, junctionPath, 'junction')
  await assert.rejects(
    policy.resolveExisting(path.join(junctionPath, 'deny.txt'), repoRoot, 'file'),
    error => error.code === 'PATH_POLICY_DENIED' && !error.message.includes(marker),
  )
  await unlink(junctionPath)
})

test('personal_glob caps a broad result at 100 paths', async () => {
  const startedAt = performance.now()
  const result = await personalGlob(policy, { path: fixtureRoot, pattern: '**/*.txt' }, exec)
  const elapsedMs = performance.now() - startedAt
  assert.equal(result.status, 'TRUNCATED')
  assert.equal(result.returnedCount, 100)
  assert.equal(result.totalObserved, 101)
  assert.equal(result.truncated, true)
  assert.ok(elapsedMs < 15000)
})

test('personal_grep caps a broad result at 250 matches and reports narrowing guidance', async () => {
  const startedAt = performance.now()
  const result = await personalGrep(policy, { path: fixtureRoot, pattern: 'MATCH_LINE' }, exec)
  const elapsedMs = performance.now() - startedAt
  assert.equal(result.status, 'TOO_BROAD')
  assert.equal(result.returnedMatchCount, 250)
  assert.ok(result.returnedFileCount <= 100)
  assert.equal(result.totalObserved, 251)
  assert.equal(result.truncated, true)
  assert.match(result.guidance, /Narrow path, include, or pattern/u)
  assert.ok(elapsedMs < 15000)
})

test('personal_grep caps a broad result at 100 files', async () => {
  const startedAt = performance.now()
  const result = await personalGrep(policy, { path: fixtureRoot, pattern: 'ONE_PER_FILE' }, exec)
  const elapsedMs = performance.now() - startedAt
  assert.equal(result.status, 'TOO_BROAD')
  assert.equal(result.returnedMatchCount, 100)
  assert.equal(result.returnedFileCount, 100)
  assert.equal(result.totalObserved, 101)
  assert.equal(result.truncated, true)
  assert.ok(elapsedMs < 15000)
})
