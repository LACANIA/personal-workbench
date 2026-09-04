import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { EvidenceAuditService } from '../src/artifacts/evidence-audit-service.ts'
import { ReleaseAuditService } from '../src/artifacts/release-audit-service.ts'
import { ReviewPolicyService } from '../src/artifacts/review-policy-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { UniversalInputService, type PickerResult } from '../src/input/service.ts'
import { ProjectContextService } from '../src/projects/service.ts'
import { TaskManager } from '../src/tasks/manager.ts'
import { VideoKnowledgeRepository } from '../src/video/repository.ts'
import { VideoKnowledgeService } from '../src/video/service.ts'
// The personal plugin is JavaScript by design and is exercised through its public policy class.
// @ts-expect-error The local plugin does not publish TypeScript declarations.
import { PathPolicy } from '../../../../plugins/personal-safe-fs/src/policy.js'

const databaseRoots: string[] = []
const externalRoots: string[] = []
const stagedRoots: string[] = []
const databases: WorkbenchDatabase[] = []

function pickerResult(kind: 'file' | 'directory', selectedPath: string | null): PickerResult {
  return { canceled: selectedPath === null, path: selectedPath, kind }
}

async function databaseRoot(): Promise<string> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', `step27-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  databaseRoots.push(root)
  return root
}

async function externalRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-workbench-step27-'))
  externalRoots.push(root)
  return root
}

async function fixture(): Promise<{
  root: string
  database: WorkbenchDatabase
  inputs: UniversalInputService
  projects: ProjectContextService
  tasks: TaskManager
}> {
  const root = await databaseRoot()
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  databases.push(database)
  const inputs = new UniversalInputService(database)
  const projects = new ProjectContextService(database, inputs)
  await projects.ensurePersonalInbox(path.join(root, 'personal-inbox'))
  const tasks = new TaskManager(database, new ArtifactService(database, new ArtifactEvidenceService(database)), inputs)
  return { root, database, inputs, projects, tasks }
}

async function selectFixture(
  database: WorkbenchDatabase,
  kind: 'file' | 'directory',
  selectedPath: string | null,
): Promise<{ service: UniversalInputService; result: Awaited<ReturnType<UniversalInputService['select']>> }> {
  const service = new UniversalInputService(database, async requestedKind => pickerResult(requestedKind, selectedPath))
  return { service, result: await service.select(kind, true) }
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const stagedRoot of stagedRoots.splice(0)) {
    const incoming = path.resolve(PATHS.personalInboxIncoming)
    const resolved = path.resolve(stagedRoot)
    if (!resolved.startsWith(`${incoming}${path.sep}`)) throw new Error('unsafe staged input cleanup path')
    await rm(resolved, { recursive: true, force: true })
  }
  for (const root of databaseRoots.splice(0)) {
    const boundary = path.resolve(PATHS.appRoot, 'data', 'test-runtime')
    const resolved = path.resolve(root)
    if (!resolved.startsWith(`${boundary}${path.sep}`)) throw new Error('unsafe database cleanup path')
    await rm(resolved, { recursive: true, force: true })
  }
  for (const root of externalRoots.splice(0)) {
    const boundary = path.resolve(os.tmpdir())
    const resolved = path.resolve(root)
    if (!resolved.startsWith(`${boundary}${path.sep}personal-workbench-step27-`)) throw new Error('unsafe external fixture cleanup path')
    await rm(resolved, { recursive: true, force: true })
  }
})

describe('STEP-27 native selection and grants', () => {
  it('returns a native file picker structure and exact-file grant', async () => {
    const { database } = await fixture()
    const root = await externalRoot()
    const file = path.join(root, 'selected.txt')
    await writeFile(file, 'selected', 'utf8')
    const { result } = await selectFixture(database, 'file', file)
    expect(result).toMatchObject({ canceled: false, kind: 'file', path: await realpath(file) })
    expect(result.asset).toMatchObject({
      asset: { input_type: 'file', source_mode: 'native_picker', access_mode: 'temporary_grant' },
      grant: { scope: 'exact_file', status: 'granted', source_mode: 'native_picker' },
    })
  })

  it('returns a native directory picker structure and directory-tree grant', async () => {
    const { database } = await fixture()
    const root = await externalRoot()
    const { result } = await selectFixture(database, 'directory', root)
    expect(result).toMatchObject({ canceled: false, kind: 'directory', path: await realpath(root) })
    expect(result.asset?.grant).toMatchObject({ kind: 'directory', scope: 'directory_tree' })
    expect(result.asset?.capability).toMatchObject({
      category: 'directory', mode: 'native_read', analyzable: true,
    })
  })

  it('returns cancellation without creating an InputAsset', async () => {
    const { database } = await fixture()
    const { result } = await selectFixture(database, 'file', null)
    expect(result).toEqual({ canceled: true, path: null, kind: 'file', asset: null })
    expect(database.listInputAssets()).toHaveLength(0)
  })

  it('requires an explicit user action for the picker', async () => {
    const { database } = await fixture()
    const service = new UniversalInputService(database, async kind => pickerResult(kind, null))
    await expect(service.select('file', false)).rejects.toThrow('INPUT_PICKER_USER_ACTION_REQUIRED')
  })

  it('prevents a manual-path asset from creating a grant', async () => {
    const { database } = await fixture()
    const root = await externalRoot()
    const file = path.join(root, 'manual.txt')
    await writeFile(file, 'manual', 'utf8')
    const assetId = randomUUID()
    database.createInputAsset({
      id: assetId, input_type: 'file', display_name: 'manual.txt', original_path: file, staged_path: null,
      access_mode: 'temporary_grant', source_mode: 'manual_path', mime_type: 'text/plain', size_bytes: 6,
      sha256: null, created_at: new Date().toISOString(), expires_at: null, task_id: null, project_id: null, metadata: {},
    })
    expect(() => database.createTemporaryInputGrant({
      grant_id: randomUUID(), input_asset_id: assetId, selected_path: file, kind: 'file', scope: 'exact_file',
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
      task_id: null, status: 'granted', source_mode: 'manual_path' as never,
    })).toThrow('INPUT_GRANT_SOURCE_DENIED')
  })

  it('does not turn an external manual path into an implicit grant', async () => {
    const { database, tasks } = await fixture()
    const root = await externalRoot()
    const file = path.join(root, 'manual.txt')
    await writeFile(file, 'manual', 'utf8')
    const task = tasks.create({ templateId: 'file-analysis', inputType: 'file', inputValue: file })
    await expect(tasks.start(task.id)).rejects.toThrow('PATH_POLICY_DENIED')
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM temporary_input_grants').get()).toEqual({ count: 0 })
  })

  it('limits an exact-file grant to the selected file and rejects its neighbor', async () => {
    const { database, tasks } = await fixture()
    const root = await externalRoot()
    const selected = path.join(root, 'selected.txt')
    const neighbor = path.join(root, 'neighbor.txt')
    await writeFile(selected, 'selected', 'utf8')
    await writeFile(neighbor, 'neighbor', 'utf8')
    const { service, result } = await selectFixture(database, 'file', selected)
    const task = tasks.create({ templateId: 'file-analysis', inputValue: selected, inputType: 'file', inputAssetId: result.asset!.asset.id })
    await expect(service.assertTaskAccess(task.id, result.asset!.asset.id, selected, 'file')).resolves.toBe(await realpath(selected))
    await expect(service.assertTaskAccess(task.id, result.asset!.asset.id, neighbor, 'file')).rejects.toThrow('PATH_POLICY_DENIED')
  })

  it('limits a directory grant to its selected tree and rejects parent traversal', async () => {
    const { database, tasks } = await fixture()
    const parent = await externalRoot()
    const selected = path.join(parent, 'selected')
    await mkdir(selected)
    const inside = path.join(selected, 'inside.txt')
    const outside = path.join(parent, 'outside.txt')
    await writeFile(inside, 'inside', 'utf8')
    await writeFile(outside, 'outside', 'utf8')
    const { service, result } = await selectFixture(database, 'directory', selected)
    const task = tasks.create({ templateId: 'asset-inventory', inputValue: selected, inputType: 'directory', inputAssetId: result.asset!.asset.id })
    await expect(service.assertTaskAccess(task.id, result.asset!.asset.id, inside, 'file')).resolves.toBe(await realpath(inside))
    await expect(service.assertTaskAccess(task.id, result.asset!.asset.id, path.join(selected, '..', 'outside.txt'), 'file')).rejects.toThrow('PATH_POLICY_DENIED')
  })

  it('rejects a junction whose real target escapes the selected directory', async () => {
    const { database, tasks } = await fixture()
    const selected = await externalRoot()
    const outside = await externalRoot()
    const secret = path.join(outside, 'outside.txt')
    await writeFile(secret, 'outside', 'utf8')
    const junction = path.join(selected, 'escape')
    await symlink(outside, junction, 'junction')
    const { service, result } = await selectFixture(database, 'directory', selected)
    const task = tasks.create({ templateId: 'asset-inventory', inputValue: selected, inputType: 'directory', inputAssetId: result.asset!.asset.id })
    await expect(service.assertTaskAccess(task.id, result.asset!.asset.id, path.join(junction, 'outside.txt'), 'file')).rejects.toThrow('PATH_POLICY_DENIED')
  })

  it('builds a task overlay that personal-safe-fs applies to one exact file', async () => {
    const { database, tasks } = await fixture()
    const root = await externalRoot()
    const selected = path.join(root, 'selected.txt')
    const neighbor = path.join(root, 'neighbor.txt')
    await writeFile(selected, 'selected', 'utf8')
    await writeFile(neighbor, 'neighbor', 'utf8')
    const { service, result } = await selectFixture(database, 'file', selected)
    const task = tasks.create({ templateId: 'file-analysis', inputValue: selected, inputType: 'file', inputAssetId: result.asset!.asset.id })
    const patchPath = await service.createTaskPolicyOverlay(task.id, result.asset!.asset.id)
    expect(patchPath).not.toBeNull()
    const patch = await readFile(patchPath!, 'utf8')
    const policyPath = patch.match(/policyPath:\s*'([^']+)'/u)?.[1]
    expect(policyPath).toBeTruthy()
    const policy = await PathPolicy.load(policyPath)
    await expect(policy.resolveExisting(selected, root, 'file')).resolves.toMatchObject({ canonicalPath: await realpath(selected) })
    await expect(policy.resolveExisting(neighbor, root, 'file')).rejects.toThrow('PATH_POLICY_DENIED')
    await service.expireForTask(task.id)
  })

  it('expires the grant at task release and records the lifecycle event', async () => {
    const { database, tasks } = await fixture()
    const root = await externalRoot()
    const file = path.join(root, 'selected.txt')
    await writeFile(file, 'selected', 'utf8')
    const { result } = await selectFixture(database, 'file', file)
    const task = tasks.create({ templateId: 'file-analysis', inputValue: file, inputType: 'file', inputAssetId: result.asset!.asset.id })
    await tasks.releaseExternalInput(task.id)
    expect(database.getInputGrantForAsset(result.asset!.asset.id)?.status).toBe('expired')
    expect(database.listEvents(task.id).map(item => item.eventType)).toContain('input.grant_expired')
  })
})

describe('STEP-27 staged copy, Inbox and project semantics', () => {
  it('stages a drag-and-drop copy with an exact SHA-256 and no original path', async () => {
    const { inputs } = await fixture()
    const bytes = Buffer.from('dragged content', 'utf8')
    const result = await inputs.stage('dragged.md', bytes, 'text/markdown')
    stagedRoots.push(path.dirname(result.asset.staged_path!))
    expect(result.asset).toMatchObject({ source_mode: 'drag_drop', access_mode: 'staged_copy', original_path: null })
    expect(result.asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await readFile(result.asset.staged_path!, 'utf8')).toBe('dragged content')
    expect(result.asset.metadata.notice).toBe('已导入分析副本，原始文件未修改。')
  })

  it('uses separate directories instead of overwriting two staged files with the same name', async () => {
    const { inputs } = await fixture()
    const first = await inputs.stage('same.txt', Buffer.from('one'))
    const second = await inputs.stage('same.txt', Buffer.from('two'))
    stagedRoots.push(path.dirname(first.asset.staged_path!), path.dirname(second.asset.staged_path!))
    expect(first.asset.staged_path).not.toBe(second.asset.staged_path)
    expect(await readFile(first.asset.staged_path!, 'utf8')).toBe('one')
    expect(await readFile(second.asset.staged_path!, 'utf8')).toBe('two')
  })

  it('rejects staged file-name traversal', async () => {
    const { inputs } = await fixture()
    await expect(inputs.stage('../escape.txt', Buffer.from('x'))).rejects.toThrow('INPUT_FILENAME_DENIED')
    await expect(inputs.stage('sub\\escape.txt', Buffer.from('x'))).rejects.toThrow('INPUT_FILENAME_DENIED')
  })

  it('binds a staged file-analysis task to Personal Inbox with auditable input events', async () => {
    const { database, inputs, tasks } = await fixture()
    const staged = await inputs.stage('analysis.txt', Buffer.from('analysis'))
    stagedRoots.push(path.dirname(staged.asset.staged_path!))
    const task = tasks.create({ templateId: 'file-analysis', inputValue: 'client-supplied-path-is-ignored', inputType: 'file', inputAssetId: staged.asset.id })
    expect(task.projectName).toBe('Personal Inbox')
    expect(task.inputValue).toBe(staged.asset.staged_path)
    expect(task.metadata.inputAssetId).toBe(staged.asset.id)
    expect(database.listEvents(task.id).map(item => item.eventType)).toEqual(expect.arrayContaining(['input.asset_created', 'input.staged']))
  })

  it('analyzes a selected folder through Personal Inbox without creating a formal project', async () => {
    const { database, tasks } = await fixture()
    const selected = await externalRoot()
    await writeFile(path.join(selected, 'asset.txt'), 'asset', 'utf8')
    const { result } = await selectFixture(database, 'directory', selected)
    const before = database.listProjectContexts()
    const task = tasks.create({ templateId: 'asset-inventory', inputValue: selected, inputType: 'directory', inputAssetId: result.asset!.asset.id })
    expect(task.projectName).toBe('Personal Inbox')
    expect(database.listProjectContexts()).toHaveLength(before.length)
    expect(database.listProjectContexts().some(item => item.rootPath === selected)).toBe(false)
  })

  it('registers a selected directory only after the explicit project action', async () => {
    const { database, inputs, projects } = await fixture()
    const selected = await externalRoot()
    await writeFile(path.join(selected, 'README.md'), '# Explicit', 'utf8')
    const { result } = await selectFixture(database, 'directory', selected)
    const project = await projects.register({ rootPath: selected, name: 'Explicit External Project', inputAssetId: result.asset!.asset.id })
    expect(project).toMatchObject({ name: 'Explicit External Project', rootPath: await realpath(selected) })
    expect(inputs.get(result.asset!.asset.id).asset).toMatchObject({ access_mode: 'project', project_id: project.id })
    expect(inputs.get(result.asset!.asset.id).grant?.status).toBe('expired')
  })

  it('preserves an explicitly selected existing project for task association', async () => {
    const { root, database, projects, tasks } = await fixture()
    const projectRoot = path.join(root, 'explicit-project')
    await mkdir(projectRoot)
    const project = await projects.register({ rootPath: projectRoot, name: 'Explicit Project' })
    const task = tasks.create({
      templateId: 'project-summary', inputType: 'question', inputValue: '总结项目',
      workspacePath: project.rootPath, projectName: project.name,
    })
    expect(task).toMatchObject({ projectId: project.id, projectName: project.name, workspacePath: project.rootPath })
  })

  it('exposes the capability matrix without claiming unsupported parsers', async () => {
    const { inputs } = await fixture()
    const matrix = inputs.capabilities().matrix
    expect(matrix.find(item => item.extensions.includes('.txt'))).toMatchObject({ mode: 'native_read', analyzable: true })
    expect(matrix.find(item => item.extensions.includes('.pdf'))).toMatchObject({ mode: 'structured_parser', analyzable: true })
    expect(matrix.find(item => item.extensions.includes('.docx'))).toMatchObject({ mode: 'structured_parser', analyzable: true })
    expect(matrix.find(item => item.extensions.includes('.pptx'))).toMatchObject({ mode: 'structured_parser', analyzable: true })
    expect(matrix.find(item => item.extensions.includes('.xlsx'))).toMatchObject({ mode: 'structured_parser', analyzable: true })
    expect(matrix.find(item => item.extensions.includes('.png'))).toMatchObject({ mode: 'metadata_only', analyzable: false })
  })

  it('deletes only an unused staged copy and leaves native selected files untouched', async () => {
    const { database, inputs } = await fixture()
    const staged = await inputs.stage('delete-me.txt', Buffer.from('copy'))
    const stagedDirectory = path.dirname(staged.asset.staged_path!)
    const removed = await inputs.deleteUnused(staged.asset.id)
    expect(removed).toMatchObject({ original_deleted: false, staged_copy_deleted: true })
    await expect(stat(stagedDirectory)).rejects.toMatchObject({ code: 'ENOENT' })

    const external = await externalRoot()
    const original = path.join(external, 'keep-me.txt')
    await writeFile(original, 'keep', 'utf8')
    const { result } = await selectFixture(database, 'file', original)
    const nativeRemoved = await inputs.deleteUnused(result.asset!.asset.id)
    expect(nativeRemoved).toMatchObject({ original_deleted: false, staged_copy_deleted: false })
    expect(await readFile(original, 'utf8')).toBe('keep')
  })
})

describe('STEP-27 Video input, API boundaries and database integrity', () => {
  it('accepts a picker-authorized SRT file in a Personal Inbox video job', async () => {
    const { database, tasks } = await fixture()
    const root = await externalRoot()
    const subtitle = path.join(root, 'sample.srt')
    await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:02,000\nhello\n', 'utf8')
    const { result } = await selectFixture(database, 'file', subtitle)
    const evidence = new ArtifactEvidenceService(database)
    const artifacts = new ArtifactService(database, evidence)
    const audit = new EvidenceAuditService(database, artifacts, evidence)
    const policy = new ReviewPolicyService(database, artifacts, evidence, audit)
    const release = new ReleaseAuditService(artifacts, evidence, audit, policy)
    const repository = new VideoKnowledgeRepository(database)
    const service = new VideoKnowledgeService(database, repository, tasks, artifacts, evidence, release)
    const job = service.create({ input_type: 'subtitle', input_value: subtitle, input_asset_id: result.asset!.asset.id, title: 'Picker Subtitle' })
    expect(job.project_id).toBe(database.getPersonalInboxProject()?.id)
    expect(database.getTask(job.task_id!)?.metadata.inputAssetId).toBe(result.asset!.asset.id)
    expect(database.getInputGrantForAsset(result.asset!.asset.id)?.status).toBe('attached_to_task')
  })

  it('maps technical URL component failures to an actionable user message', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'web', 'src', 'pages', 'VideoPage.tsx'), 'utf8')
    expect(source).toContain("message.includes('VIDEO_URL_QUERY_DENIED')")
    expect(source).toContain('当前电脑尚未配置可用的 yt-dlp')
    expect(source).toContain('请在设置页面检查媒体组件')
  })

  it('keeps the server loopback-only and requires token plus Origin checks', async () => {
    const source = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'index.ts'), 'utf8')
    expect(source).toContain("const HOST = '127.0.0.1'")
    expect(source).toContain("request.headers['x-workbench-token'] === TOKEN")
    expect(source).toContain('origin === `http://${HOST}:${boundPort}`')
    expect(source).not.toContain("listen('0.0.0.0'")
  })

  it('uses the fixed picker helper through a parameter array and shell-free process execution', async () => {
    const picker = await readFile(path.join(PATHS.appRoot, 'server', 'helpers', 'input-picker.ps1'), 'utf8')
    const service = await readFile(path.join(PATHS.appRoot, 'server', 'src', 'input', 'service.ts'), 'utf8')
    expect(picker).toContain('OpenFileDialog')
    expect(picker).toContain('FolderBrowserDialog')
    expect(picker).toContain("PSObject.Properties.Name -contains 'UseDescriptionForTitle'")
    expect(service).toContain("'-File', script, '-Kind', kind")
    expect(service).not.toContain('shell: true')
  })

  it('keeps the permanent path policy unchanged and free of temporary grants', async () => {
    const policy = await readFile(PATHS.policy, 'utf8')
    const parsed = JSON.parse(policy) as { allowedRoots?: unknown }
    expect(Array.isArray(parsed.allowedRoots)).toBe(true)
    expect(parsed.allowedRoots).not.toHaveLength(0)
    expect(policy).not.toContain('temporaryGrant')
    expect(policy).not.toContain('allowedFiles')
  })

  it('passes SQLite integrity and foreign-key checks after Universal Input records', async () => {
    const { database } = await fixture()
    const root = await externalRoot()
    const file = path.join(root, 'input.txt')
    await writeFile(file, 'input', 'utf8')
    await selectFixture(database, 'file', file)
    expect(database.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(database.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
