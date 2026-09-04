import { deflateSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const emittedRoot = path.join(appRoot, 'desktop-dist')
const stagingRoot = path.join(appRoot, 'desktop-release', 'app-runtime')
const releaseRoot = path.dirname(stagingRoot)
const labRoot = path.resolve(appRoot, '..', '..', '..')
const harnessSourceRoot = path.join(labRoot, 'deepseek-harness')
const agentRoot = path.resolve(appRoot, '..', '..')

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const name = Buffer.from(type)
  const output = Buffer.alloc(12 + data.length)
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8)
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return output
}

function createIconPng(size = 256) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const offset = y * (size * 4 + 1) + 1 + x * 4
      const radius = 48
      const inside = (x >= radius || y >= radius || ((x - radius) ** 2 + (y - radius) ** 2 <= radius ** 2))
        && (x < size - radius || y >= radius || ((x - size + radius) ** 2 + (y - radius) ** 2 <= radius ** 2))
        && (x >= radius || y < size - radius || ((x - radius) ** 2 + (y - size + radius) ** 2 <= radius ** 2))
        && (x < size - radius || y < size - radius || ((x - size + radius) ** 2 + (y - size + radius) ** 2 <= radius ** 2))
      const whiteLetter = inside && ((x >= 54 && x <= 76 && y >= 68 && y <= 188)
        || (x >= 76 && x <= 116 && ((y >= 68 && y <= 90) || (y >= 116 && y <= 138)))
        || (x >= 94 && x <= 116 && y >= 82 && y <= 124)
        || (x >= 132 && x <= 152 && y >= 68 && y <= 188)
        || (x >= 184 && x <= 204 && y >= 68 && y <= 188)
        || (x >= 152 && x <= 184 && y >= 166 && y <= 188))
      raw[offset] = whiteLetter ? 255 : inside ? 78 : 0
      raw[offset + 1] = whiteLetter ? 255 : inside ? 101 : 0
      raw[offset + 2] = whiteLetter ? 255 : inside ? 239 : 0
      raw[offset + 3] = inside ? 255 : 0
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))])
}

async function copyTree(source, destination, filter = () => true) {
  const info = await stat(source)
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true })
    for (const name of await readdir(source)) {
      const relative = path.relative(appRoot, path.join(source, name)).replaceAll('\\', '/')
      if (filter(relative)) await copyTree(path.join(source, name), path.join(destination, name), filter)
    }
  } else {
    await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination)
  }
}

async function removeGeneratedBinDirectories(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.name === '.bin' && entry.isDirectory()) {
      await rm(absolute, { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) await removeGeneratedBinDirectories(absolute)
  }
}

async function removeDevelopmentPathBundles(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await removeDevelopmentPathBundles(absolute)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    const content = await readFile(absolute, 'utf8')
    if (content.includes(harnessSourceRoot)) await rm(absolute, { force: true })
  }
}

async function mergeTopLevelModules(sourceRoot, destinationRoot) {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const source = path.join(sourceRoot, entry.name)
    const destination = path.join(destinationRoot, entry.name)
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      await mkdir(destination, { recursive: true })
      for (const child of await readdir(source)) {
        const childDestination = path.join(destination, child)
        try { await stat(childDestination); continue } catch { /* copy missing scoped package */ }
        await copyTree(path.join(source, child), childDestination)
      }
      continue
    }
    try { await stat(destination); continue } catch { /* copy missing package */ }
    await copyTree(source, destination)
  }
}

function deployHarnessPackage(packageName, destination) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(pnpm, [
    '--filter', packageName,
    'deploy', '--prod', '--legacy',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    destination,
  ], {
    cwd: harnessSourceRoot,
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) throw new Error(`HARNESS_RUNTIME_DEPLOY_FAILED:${packageName}:${result.status}:${result.error?.message ?? ''}`)
}

async function copyBuiltHarnessPackage(packageName, sourceRelative, runtimeRoot) {
  const source = path.join(harnessSourceRoot, ...sourceRelative.split('/'))
  const destination = path.join(runtimeRoot, 'node_modules', ...packageName.split('/'))
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const entry of ['package.json', 'lib', 'cordis.yml', 'cordis.patch.yml']) {
    const sourceEntry = path.join(source, entry)
    try {
      const info = await stat(sourceEntry)
      if (info.isDirectory()) await copyTree(sourceEntry, path.join(destination, entry))
      else await copyFile(sourceEntry, path.join(destination, entry))
    } catch { /* optional published entry */ }
  }
}

async function prepareHarnessRuntime() {
  const runtimeRoot = path.join(stagingRoot, 'harness')
  const cliDeployRoot = path.join(releaseRoot, 'harness-cli-deploy')
  deployHarnessPackage('dsh-jsonrpc-agent-pkg', runtimeRoot)
  deployHarnessPackage('@deepseek-ai/dsh', cliDeployRoot)

  // The CLI closure and JSON-RPC closure complement each other. The six
  // entries below are audited runtime peers used by the base profile; pnpm's
  // legacy deploy deliberately omits workspace peers unless a deploy root
  // names them directly.
  const supplementalHarnessPackages = [
    ['@deepseek-ai/dsh-atomic-write', 'packages/util/atomic-write'],
    ['@deepseek-ai/dsh-bash-local', 'packages/shell/bash-local'],
    ['@deepseek-ai/dsh-session-telemetry', 'packages/session/session-telemetry'],
    ['@deepseek-ai/dsh-session-title-llm', 'packages/session/session-title-llm'],
    ['@deepseek-ai/dsh-shell', 'packages/shell/shell'],
    ['@deepseek-ai/dsh-spill', 'packages/spill/spill'],
  ]

  await copyTree(path.join(harnessSourceRoot, 'apps', 'cli', 'lib'), path.join(runtimeRoot, 'apps', 'cli', 'lib'))
  await copyTree(path.join(harnessSourceRoot, 'apps', 'cli', 'config'), path.join(runtimeRoot, 'apps', 'cli', 'config'))
  await copyFile(path.join(harnessSourceRoot, 'apps', 'cli', 'package.json'), path.join(runtimeRoot, 'apps', 'cli', 'package.json'))
  for (const sdkPackage of ['client', 'server']) {
    await copyTree(path.join(harnessSourceRoot, 'packages', 'sdk', sdkPackage, 'lib'), path.join(runtimeRoot, 'packages', 'sdk', sdkPackage, 'lib'))
    await mkdir(path.join(runtimeRoot, 'packages', 'sdk', sdkPackage), { recursive: true })
    await copyFile(path.join(harnessSourceRoot, 'packages', 'sdk', sdkPackage, 'package.json'), path.join(runtimeRoot, 'packages', 'sdk', sdkPackage, 'package.json'))
  }
  await copyTree(path.join(agentRoot, 'plugins', 'personal-safe-fs'), path.join(runtimeRoot, 'node_modules', '@local', 'personal-safe-fs'), relative => {
    return relative.endsWith('package.json') || relative.endsWith('README.md') || relative.includes('/src/') || !path.extname(relative)
  })

  await mergeTopLevelModules(path.join(cliDeployRoot, 'node_modules'), path.join(runtimeRoot, 'node_modules'))
  for (const [packageName, sourceRelative] of supplementalHarnessPackages) {
    await copyBuiltHarnessPackage(packageName, sourceRelative, runtimeRoot)
  }
  await copyBuiltHarnessPackage('@deepseek-ai/cosmokit', 'vendor/cosmokit', runtimeRoot)
  await copyBuiltHarnessPackage('@deepseek-ai/schemastery', 'vendor/schemastery', runtimeRoot)
  const verification = spawnSync(process.execPath, [path.join(runtimeRoot, 'apps', 'cli', 'lib', 'bin.js'), '--version'], {
    cwd: runtimeRoot,
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    shell: false,
  })
  if (verification.status !== 0 || !verification.stdout.includes('0.1.0-rc.5')) {
    throw new Error(`HARNESS_RUNTIME_VERIFY_FAILED:${verification.stderr}`)
  }
  await removeGeneratedBinDirectories(path.join(runtimeRoot, 'node_modules'))
  await removeDevelopmentPathBundles(path.join(runtimeRoot, 'node_modules', '@deepseek-ai'))
  await rm(path.join(runtimeRoot, 'node_modules', '.pnpm'), { recursive: true, force: true })
  await rm(path.join(runtimeRoot, 'node_modules', '.modules.yaml'), { force: true })
  await rm(cliDeployRoot, { recursive: true, force: true })
}

await rm(path.join(appRoot, 'desktop-release'), { recursive: true, force: true })
await mkdir(stagingRoot, { recursive: true })

// Explicit release allowlist: emitted server/shared JavaScript, compiled web UI,
// controlled native picker, optional media worker entrypoints, dictionary and icon.
await copyTree(path.join(emittedRoot, 'server'), path.join(stagingRoot, 'server'), relative => relative.endsWith('.js') || !path.extname(relative))
await copyTree(path.join(emittedRoot, 'shared'), path.join(stagingRoot, 'shared'), relative => relative.endsWith('.js') || !path.extname(relative))
await copyTree(path.join(appRoot, 'web', 'dist'), path.join(stagingRoot, 'web', 'dist'))
await mkdir(path.join(stagingRoot, 'server', 'helpers'), { recursive: true })
await copyFile(path.join(appRoot, 'server', 'helpers', 'input-picker.ps1'), path.join(stagingRoot, 'server', 'helpers', 'input-picker.ps1'))
for (const worker of ['ocr.py', 'transcribe.py', 'asr_benchmark.py']) {
  await mkdir(path.join(stagingRoot, 'server', 'workers'), { recursive: true })
  await copyFile(path.join(appRoot, 'server', 'workers', worker), path.join(stagingRoot, 'server', 'workers', worker))
}
await mkdir(path.join(stagingRoot, 'server', 'src', 'video'), { recursive: true })
await copyFile(path.join(appRoot, 'server', 'src', 'video', 'domain_dictionary.json'), path.join(stagingRoot, 'server', 'src', 'video', 'domain_dictionary.json'))
await prepareHarnessRuntime()

const png = createIconPng()
const icoHeader = Buffer.alloc(22)
icoHeader.writeUInt16LE(0, 0); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4)
icoHeader[6] = 0; icoHeader[7] = 0; icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12)
icoHeader.writeUInt32LE(png.length, 14); icoHeader.writeUInt32LE(22, 18)
await mkdir(path.join(stagingRoot, 'assets'), { recursive: true })
await writeFile(path.join(stagingRoot, 'assets', 'app-icon.ico'), Buffer.concat([icoHeader, png]))
await writeFile(path.join(stagingRoot, 'assets', 'app-icon.png'), png)

const packageValue = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
const manifest = {
  manifest_version: 1,
  product: 'Personal Workbench', version: packageValue.version,
  created_at: new Date().toISOString(),
  allowlist: ['server/**/*.js', 'shared/**/*.js', 'web/dist/**', 'server/helpers/input-picker.ps1', 'server/workers/{ocr,transcribe,asr_benchmark}.py', 'server/src/video/domain_dictionary.json', 'harness production runtime closure', 'assets/app-icon.{ico,png}'],
  excluded: ['*.db', 'local-config.json', 'personal-inbox/**', 'validation-logs/**', 'validation-fixtures/**', 'screenshots/**', 'models/**', 'user outputs'],
  media_runtime: { version: 1, bundled_binaries: [], install_location: '%LOCALAPPDATA%\\PersonalWorkbench\\runtime\\media', optional: true },
  harness_runtime: { version: '0.1.0-rc.5', source_commit: '47f943859bef60e4160492346772ded9b24f765a', source_code_repository_included: false },
}
await writeFile(path.join(stagingRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`${stagingRoot}\n`)
