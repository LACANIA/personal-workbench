import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageValue = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
const version = packageValue.version
const output = path.join(appRoot, 'dist-desktop')
const installerName = (await readdir(output)).find(name => /^Personal-Workbench-Setup-.*-x64\.exe$/u.test(name))
if (!installerName) throw new Error('DESKTOP_INSTALLER_NOT_FOUND')
const releaseRoot = path.resolve(appRoot, '..', '..', '..', 'releases', 'personal-workbench', version)
await mkdir(releaseRoot, { recursive: true })
const installerSource = path.join(output, installerName)
const installerTarget = path.join(releaseRoot, installerName)
await copyFile(installerSource, installerTarget)
const bytes = await readFile(installerTarget)
const sha256 = createHash('sha256').update(bytes).digest('hex')
await writeFile(path.join(releaseRoot, 'SHA256SUMS.txt'), `${sha256}  ${installerName}\n`, 'utf8')
const manifest = {
  product: 'Personal Workbench', version, build_time: new Date().toISOString(), platform: 'win32', arch: 'x64',
  installer: installerName, installer_sha256: sha256,
  required_models: ['qwen3:8b', 'qwen3-embedding:0.6b'], optional_models: ['qwen2.5-coder:7b'],
  optional_components: ['FFmpeg', 'ffprobe', 'yt-dlp', 'RapidOCR', 'faster-whisper GPU/CPU runtime'],
  database_schema: 1, runtime_manifest_version: 1, code_signing: 'unsigned', user_data_removed_by_default_uninstall: false,
}
await writeFile(path.join(releaseRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await copyFile(path.join(appRoot, 'distribution', 'THIRD_PARTY_LICENSES.md'), path.join(releaseRoot, 'THIRD_PARTY_LICENSES.md'))
await copyFile(path.join(appRoot, 'distribution', 'README-FIRST-RUN.md'), path.join(releaseRoot, 'README-FIRST-RUN.md'))
process.stdout.write(`${JSON.stringify({ releaseRoot, installer: installerTarget, sha256 })}\n`)
