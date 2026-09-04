import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, opendir, readFile, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DetectedKnowledgeSource, KnowledgeSourceAdapterHealth, UnifiedDocumentCodeBlock, UnifiedDocumentRecord, UnifiedDocumentSection } from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { runProcess, type ProcessResult } from '../process.ts'
import { artifactBelongsToRoot } from '../artifacts/service.ts'
import { assertPublicDnsTarget, validatePublicHttpUrl } from './safe-http.ts'
import type { KnowledgeSourceAdapter, SourceAdapterContext } from './types.ts'
import { SourceAdapterError } from './types.ts'

const MANIFEST_NAMES = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'cmakelists.txt', 'dockerfile', 'docker-compose.yml'])
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'vendor', 'venv', '.venv', '__pycache__', 'coverage', '.next', '.cache'])
const BINARY_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.zip', '.7z', '.rar', '.tar', '.gz', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.mp4', '.mkv', '.mov', '.webm', '.db', '.sqlite', '.onnx', '.safetensors', '.pt', '.pth'])
const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.sh', '.ps1', '.html', '.css', '.scss', '.sql', '.vue', '.svelte'])
const MAX_REPOSITORY_FILES = 2_500
const MAX_SCAN_DEPTH = 10
const MAX_SINGLE_FILE_BYTES = 220 * 1024
const MAX_SELECTED_FILES = 12
const MAX_SELECTED_CONTENT_BYTES = 850 * 1024

export const GITHUB_CLONE_FIXED_ARGS = ['clone', '--depth', '1', '--filter=blob:none', '--no-tags'] as const

interface ScannedFile {
  relativePath: string
  sizeBytes: number
  depth: number
  text: boolean
  binary: boolean
}

interface SelectedFile extends ScannedFile {
  selected_reason: string
  content: string
}

function compact(value: string, maximum = 40_000): string { return value.replace(/\r\n?/gu, '\n').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim().slice(0, maximum) }
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function normalizePath(value: string): string { return value.replace(/\\/gu, '/').replace(/^\.\//u, '') }
function basename(value: string): string { return path.posix.basename(normalizePath(value)).toLowerCase() }
function extension(value: string): string { return path.posix.extname(normalizePath(value)).toLowerCase() }

export function normalizeGithubRepositoryUrl(value: string): { canonical: string; owner: string; repo: string; kind: 'repository' | 'issue' | 'pull_request' | 'file' } {
  const url = validatePublicHttpUrl(value)
  if (url.hostname.toLowerCase() !== 'github.com') throw new SourceAdapterError('GITHUB_URL_INVALID', '请粘贴公开 GitHub 仓库链接。')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) throw new SourceAdapterError('GITHUB_REPOSITORY_REQUIRED', '链接中没有包含 GitHub 仓库名称。')
  const owner = parts[0]!
  const repo = parts[1]!.replace(/\.git$/iu, '')
  if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/u.test(repo)) throw new SourceAdapterError('GITHUB_URL_INVALID', 'GitHub 仓库地址格式无效。')
  const third = parts[2]?.toLowerCase()
  const kind = third === 'issues' ? 'issue' : third === 'pull' ? 'pull_request' : third === 'blob' || third === 'tree' ? 'file' : 'repository'
  return { canonical: `https://github.com/${owner}/${repo}`, owner, repo, kind }
}

export function githubCloneArgs(canonicalUrl: string, destination: string): string[] {
  return [...GITHUB_CLONE_FIXED_ARGS, canonicalUrl, destination]
}

function ignoreFromGitignore(content: string): string[] {
  return content.split(/\r?\n/gu).map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
    .filter(line => /^[A-Za-z0-9_.\-/]+\/?$/u.test(line)).map(line => line.replace(/^\//u, '').replace(/\/$/u, ''))
}

function ignored(relativePath: string, ignorePatterns: string[]): boolean {
  const pieces = normalizePath(relativePath).split('/')
  if (pieces.slice(0, -1).some(piece => IGNORED_DIRECTORIES.has(piece.toLowerCase()))) return true
  const normalized = normalizePath(relativePath)
  return ignorePatterns.some(pattern => normalized === pattern || normalized.startsWith(`${pattern}/`) || pieces.includes(pattern))
}

function probableBinary(file: ScannedFile): boolean { return file.binary || BINARY_EXTENSIONS.has(extension(file.relativePath)) }

function selectionReason(file: ScannedFile): { score: number; reason: string } {
  const name = basename(file.relativePath)
  if (/^readme(?:\.[a-z0-9]+)?$/iu.test(name)) return { score: 300, reason: '项目说明文档' }
  if (MANIFEST_NAMES.has(name) || /\.(?:sln|csproj)$/iu.test(name)) return { score: 280, reason: '依赖或构建清单' }
  if (/^(?:main|app|index|server|cli)\.(?:ts|tsx|js|mjs|cjs|py|go|rs|java|cs)$/iu.test(name) || /\/src\/(?:main|app|index|server)\./iu.test(`/${file.relativePath}`)) return { score: 240, reason: '可能的核心入口' }
  if (/^(?:docker-compose\.ya?ml|dockerfile|\.env\.example)$/iu.test(name)) return { score: 220, reason: '部署或配置说明' }
  if (file.relativePath.toLowerCase().startsWith('docs/')) return { score: 180, reason: '项目文档' }
  if (TEXT_EXTENSIONS.has(extension(file.relativePath))) return { score: 100, reason: '代表性文本或代码文件' }
  return { score: 0, reason: '未选择' }
}

function technologySignals(files: ScannedFile[]): string[] {
  const names = new Set(files.map(file => basename(file.relativePath)))
  const signals: string[] = []
  if (names.has('package.json')) signals.push('Node.js / JavaScript 或 TypeScript')
  if (names.has('pyproject.toml') || names.has('requirements.txt')) signals.push('Python')
  if (names.has('cargo.toml')) signals.push('Rust')
  if (names.has('go.mod')) signals.push('Go')
  if (names.has('pom.xml') || names.has('build.gradle')) signals.push('Java / JVM')
  if (names.has('cmakelists.txt')) signals.push('C/C++')
  if (files.some(file => /\.(?:sln|csproj)$/iu.test(file.relativePath))) signals.push('.NET')
  if (names.has('dockerfile') || names.has('docker-compose.yml')) signals.push('Docker')
  return signals
}

async function scanRepository(root: string): Promise<{ files: ScannedFile[]; partial: boolean; ignored_count: number; binary_count: number; ignore_patterns: string[] }> {
  let ignorePatterns: string[] = []
  try { ignorePatterns = ignoreFromGitignore(await readFile(path.join(root, '.gitignore'), 'utf8')) } catch { /* optional */ }
  const files: ScannedFile[] = []
  let partial = false
  let ignoredCount = 0
  let binaryCount = 0
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || files.length >= MAX_REPOSITORY_FILES) { partial = true; return }
    const directory = await opendir(current)
    for await (const entry of directory) {
      if (files.length >= MAX_REPOSITORY_FILES) { partial = true; return }
      const entryPath = path.join(current, entry.name)
      const relativePath = normalizePath(path.relative(root, entryPath))
      if (relativePath.length === 0 || relativePath.startsWith('../') || path.isAbsolute(relativePath) || entry.isSymbolicLink()) { ignoredCount += 1; continue }
      if (ignored(relativePath, ignorePatterns)) { ignoredCount += 1; continue }
      if (entry.isDirectory()) { await visit(entryPath, depth + 1); continue }
      if (!entry.isFile()) { ignoredCount += 1; continue }
      const info = await stat(entryPath)
      const binary = BINARY_EXTENSIONS.has(extension(relativePath))
      if (binary) binaryCount += 1
      const name = basename(relativePath)
      const text = !binary && (
        TEXT_EXTENSIONS.has(extension(relativePath)) || name === 'dockerfile' || MANIFEST_NAMES.has(name) || /^readme(?:\.[a-z0-9]+)?$/iu.test(name)
      )
      files.push({ relativePath, sizeBytes: info.size, depth, text, binary })
    }
  }
  await visit(root, 0)
  return { files, partial, ignored_count: ignoredCount, binary_count: binaryCount, ignore_patterns: ignorePatterns }
}

async function selectFiles(root: string, files: ScannedFile[]): Promise<SelectedFile[]> {
  const candidates = files.filter(file => file.text && !probableBinary(file) && file.sizeBytes <= MAX_SINGLE_FILE_BYTES)
    .map(file => ({ file, ...selectionReason(file) })).filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.file.relativePath.localeCompare(right.file.relativePath))
  const selected: SelectedFile[] = []
  let totalBytes = 0
  for (const candidate of candidates) {
    if (selected.length >= MAX_SELECTED_FILES || totalBytes >= MAX_SELECTED_CONTENT_BYTES) break
    const candidatePath = path.resolve(root, candidate.file.relativePath)
    const canonical = await realpath(candidatePath)
    if (!artifactBelongsToRoot(canonical, root)) continue
    const content = await readFile(canonical, 'utf8').catch(() => null)
    if (content === null || content.includes('\0')) continue
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_SINGLE_FILE_BYTES || totalBytes + bytes > MAX_SELECTED_CONTENT_BYTES) continue
    totalBytes += bytes
    selected.push({ ...candidate.file, selected_reason: candidate.reason, content: content.replace(/\r\n?/gu, '\n') })
  }
  return selected
}

function extractLicense(files: ScannedFile[]): string | null {
  const license = files.find(file => /^licen[sc]e(?:\.[a-z0-9]+)?$/iu.test(basename(file.relativePath)))
  return license?.relativePath ?? null
}

function markdownForRepository(input: { repo: string; commit: string; branch: string | null; files: ScannedFile[]; selected: SelectedFile[]; technologies: string[] }): { content: string; sections: UnifiedDocumentSection[]; code_blocks: UnifiedDocumentCodeBlock[] } {
  const sections: UnifiedDocumentSection[] = []
  const codeBlocks: UnifiedDocumentCodeBlock[] = []
  const lines: string[] = [`# ${input.repo}`, '']
  const append = (heading: string, level: number, text: string, anchor: string): void => {
    lines.push(`${'#'.repeat(level)} ${heading}`, '', text, '')
    sections.push({ heading, level, text, source_anchor: anchor })
  }
  append('项目概览', 2, `提交：${input.commit}${input.branch === null ? '' : `\n分支：${input.branch}`}\n技术栈：${input.technologies.join('；') || '仓库资料未能明确识别。'}`, 'repository-overview')
  append('目录结构', 2, input.files.slice(0, 400).map(file => `${file.relativePath}${file.binary ? '（二进制，仅登记）' : ''}`).join('\n') || '仓库中没有可分析文件。', 'repository-tree')
  for (const file of input.selected) {
    const heading = file.relativePath
    const language = extension(file.relativePath).replace(/^\./u, '') || null
    const summary = `${file.selected_reason}；${file.sizeBytes} 字节。`
    append(heading, 2, `${summary}\n\n\`\`\`${language ?? ''}\n${file.content}\n\`\`\``, file.relativePath)
    codeBlocks.push({ language, content: file.content, source_anchor: file.relativePath })
  }
  return { content: compact(lines.join('\n'), 420_000), sections, code_blocks: codeBlocks }
}

function gitExecutable(): string | null {
  const pathCandidates = (process.env.PATH ?? '').split(path.delimiter)
    .filter(Boolean)
    .map(directory => path.join(directory.replace(/^"|"$/gu, ''), process.platform === 'win32' ? 'git.exe' : 'git'))
  const candidates = [
    process.env.WORKBENCH_GIT_EXECUTABLE,
    process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git',
    process.platform === 'win32' && process.env.LOCALAPPDATA !== undefined ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe') : null,
    ...pathCandidates,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find(candidate => path.isAbsolute(candidate) && existsSync(candidate)) ?? null
}

export class GitHubSourceAdapter implements KnowledgeSourceAdapter {
  readonly id = 'github' as const
  constructor(
    private readonly execute: (executable: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ProcessResult> = runProcess,
    private readonly root = PATHS.githubRuntime,
    private readonly executable = gitExecutable,
    private readonly assertPublicTarget: (url: URL) => Promise<void> = assertPublicDnsTarget,
  ) {}

  canHandle(source: DetectedKnowledgeSource): boolean { return source.source_type === 'github_repo' && source.metadata.github_kind === 'repository' }

  async inspect(source: DetectedKnowledgeSource): Promise<Record<string, unknown>> {
    const parsed = normalizeGithubRepositoryUrl(source.source_reference)
    await this.assertPublicTarget(new URL(parsed.canonical))
    const executable = this.executable()
    if (executable === null) throw new SourceAdapterError('GIT_EXECUTABLE_MISSING', '当前电脑没有可用的 Git，暂时不能读取 GitHub 项目。')
    return { adapter: this.id, canonical_url: parsed.canonical, kind: parsed.kind, git_executable: executable }
  }

  async acquire(source: DetectedKnowledgeSource, context: SourceAdapterContext): Promise<UnifiedDocumentRecord> {
    const inspected = await this.inspect(source)
    const parsed = normalizeGithubRepositoryUrl(source.source_reference)
    if (parsed.kind !== 'repository') throw new SourceAdapterError('GITHUB_SOURCE_KIND_UNSUPPORTED', '当前版本主要读取 GitHub 仓库主页；Issue、Pull Request 和单文件链接会在后续版本完善。')
    const executable = String(inspected.git_executable)
    const jobRoot = path.resolve(this.root, context.taskId)
    const repoRoot = path.resolve(jobRoot, 'repo')
    if (!artifactBelongsToRoot(repoRoot, this.root)) throw new SourceAdapterError('GITHUB_RUNTIME_PATH_DENIED', 'GitHub 临时工作目录无效。')
    await mkdir(jobRoot, { recursive: true })
    const canonicalJobRoot = await realpath(jobRoot)
    try {
      context.report({ stage: 'fetching', progress: 16, message: '正在获取公开 GitHub 项目。', tool: '受控 Git 浅克隆' })
      const clone = await this.execute(executable, githubCloneArgs(parsed.canonical, repoRoot), { cwd: canonicalJobRoot, timeoutMs: 90_000 })
      if (clone.exitCode !== 0 || clone.timedOut) throw new SourceAdapterError('GITHUB_CLONE_FAILED', '无法获取该公开 GitHub 项目，请检查网络、仓库地址或 Git 组件。', 502)
      const canonicalRoot = await realpath(repoRoot)
      if (!artifactBelongsToRoot(canonicalRoot, canonicalJobRoot)) throw new SourceAdapterError('GITHUB_REPOSITORY_TRAVERSAL_DENIED', '仓库目录超出了受控范围，已经停止分析。')
      const commitResult = await this.execute(executable, ['-C', canonicalRoot, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
      const branchResult = await this.execute(executable, ['-C', canonicalRoot, 'branch', '--show-current'], { timeoutMs: 10_000 })
      if (commitResult.exitCode !== 0) throw new SourceAdapterError('GITHUB_COMMIT_UNAVAILABLE', '没有读取到仓库提交版本，已经停止分析。', 502)
      const commit = commitResult.stdout.trim().slice(0, 80)
      const branch = branchResult.exitCode === 0 && branchResult.stdout.trim().length > 0 ? branchResult.stdout.trim().slice(0, 120) : null
      context.report({ stage: 'processing', progress: 35, message: '正在扫描项目目录和依赖清单。', tool: '只读仓库扫描器' })
      const scanned = await scanRepository(canonicalRoot)
      context.report({ stage: 'processing', progress: 48, message: `发现 ${scanned.files.length} 个受控文件，正在选择关键文件。`, tool: '关键文件选择器' })
      const selected = await selectFiles(canonicalRoot, scanned.files)
      const technologies = technologySignals(scanned.files)
      const rendered = markdownForRepository({ repo: `${parsed.owner}/${parsed.repo}`, commit, branch, files: scanned.files, selected, technologies })
      context.report({ stage: 'extracting', progress: 60, message: `已选择 ${selected.length} 个关键文件，正在整理技术资料。`, tool: '关键文件选择器' })
      const metadata: Record<string, unknown> = {
        adapter: this.id, repository_owner: parsed.owner, repository_name: parsed.repo, repository_commit: commit, branch,
        file_count: scanned.files.length, ignored_count: scanned.ignored_count, binary_count: scanned.binary_count,
        partial: scanned.partial, status: scanned.partial ? 'REPOSITORY_TOO_LARGE_PARTIAL' : 'complete', technologies,
        selected_files: selected.map(file => ({ repo_relative_path: file.relativePath, selected_reason: file.selected_reason, size_bytes: file.sizeBytes })),
        user_instruction: source.metadata.user_instruction ?? null,
      }
      return {
        id: randomUUID(), task_id: context.taskId, project_id: context.projectId, source_type: 'github_repo',
        source_url: source.source_reference, canonical_url: parsed.canonical, title: `${parsed.owner}/${parsed.repo}`,
        author: parsed.owner, site_name: 'GitHub', description: null, language: null, content_type: 'text/markdown',
        content: rendered.content, sections: rendered.sections, code_blocks: rendered.code_blocks,
        links: [parsed.canonical], metadata, acquired_at: new Date().toISOString(), content_sha256: hash(rendered.content),
      }
    } finally {
      // Source content, commit, selected paths and generated Artifacts remain available; the clone itself is disposable.
      await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  normalize(document: UnifiedDocumentRecord): UnifiedDocumentRecord { return document }
  toUnifiedDocument(document: UnifiedDocumentRecord): UnifiedDocumentRecord { return document }
  async health(): Promise<KnowledgeSourceAdapterHealth> {
    const executable = this.executable()
    return executable === null ? { id: this.id, available: false, detail: '未检测到固定 Git 可执行程序' } : { id: this.id, available: true, detail: executable }
  }
}
