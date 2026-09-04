import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { UniversalInputService } from '../src/input/service.ts'
import { FileOrganizerService } from '../src/organizer/service.ts'
import { OrganizerContentResolver } from '../src/organizer/content-resolver.ts'
import { completeOrganizerClassifications, validateOrganizerClassifications } from '../src/organizer/classification-provider.ts'
import { ProjectContextService } from '../src/projects/service.ts'
import { TaskManager } from '../src/tasks/manager.ts'

const appRoots: string[] = []
const selectedRoots: string[] = []
const databases: WorkbenchDatabase[] = []

async function fixture(): Promise<{ root: string; selected: string; service: FileOrganizerService; inputs: UniversalInputService; database: WorkbenchDatabase }> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', `step37-${randomUUID()}`)
  const selected = await mkdtemp(path.join(os.tmpdir(), 'personal-workbench-step37-'))
  appRoots.push(root); selectedRoots.push(selected)
  await mkdir(root, { recursive: true })
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db')); databases.push(database)
  const inputs = new UniversalInputService(database, async kind => ({ canceled: false, path: selected, kind }))
  const projects = new ProjectContextService(database, inputs)
  await projects.ensurePersonalInbox(path.join(root, 'personal-inbox'))
  const tasks = new TaskManager(database, new ArtifactService(database), inputs)
  return { root, selected, service: new FileOrganizerService(database, tasks), inputs, database }
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const root of appRoots.splice(0)) await rm(root, { recursive: true, force: true })
  for (const root of selectedRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('STEP-37 personal file organizer', () => {
  it('keeps a dry run read-only, protects a project, then moves and undoes selected files', async () => {
    const { selected, service, inputs } = await fixture()
    await mkdir(path.join(selected, 'project-a'), { recursive: true })
    await writeFile(path.join(selected, 'linear-algebra.pdf'), 'study', 'utf8')
    await writeFile(path.join(selected, 'photo.jpg'), 'image', 'utf8')
    await writeFile(path.join(selected, 'project-a', 'package.json'), '{"name":"project-a"}', 'utf8')
    await writeFile(path.join(selected, 'project-a', 'index.ts'), 'export const value = 1', 'utf8')
    const before = await readFile(path.join(selected, 'linear-algebra.pdf'))
    const picked = await inputs.select('directory', true)
    const plan = await service.scan({ input_asset_id: picked.asset!.asset.id, mode: 'light' })
    expect(plan.status).toBe('draft')
    expect(await readFile(path.join(selected, 'linear-algebra.pdf'))).toEqual(before)
    expect(plan.scan.project_roots).toContain('project-a')
    expect(plan.operations.some(operation => operation.source_relative_path === path.join('project-a', 'index.ts'))).toBe(false)
    const moves = plan.operations.filter(operation => operation.type === 'move').map(operation => operation.id)
    const approved = service.approve(plan.id, moves)
    expect(approved.status).toBe('approved')
    const executed = await service.execute(plan.id)
    expect(executed.status).toBe('completed')
    expect(await readFile(path.join(selected, '学习资料', 'linear-algebra.pdf'))).toEqual(before)
    expect(await readFile(path.join(selected, 'project-a', 'index.ts'), 'utf8')).toContain('value')
    const reauthorized = await inputs.select('directory', true)
    const restored = await service.undo(plan.id, reauthorized.asset!.asset.id)
    expect(restored.status).toBe('undone')
    expect(await readFile(path.join(selected, 'linear-algebra.pdf'))).toEqual(before)
  })

  it('requires the same directory to be selected again before a persisted plan can be undone', async () => {
    const { root, selected, service, inputs, database } = await fixture()
    await writeFile(path.join(selected, 'lesson.pdf'), 'local content', 'utf8')
    const initial = await inputs.select('directory', true)
    const plan = await service.scan({ input_asset_id: initial.asset!.asset.id, mode: 'light' })
    service.approve(plan.id, plan.operations.filter(operation => operation.type === 'move').map(operation => operation.id))
    await service.execute(plan.id)
    database.close()
    databases.splice(databases.indexOf(database), 1)

    const reopened = new WorkbenchDatabase(path.join(root, 'workbench.db')); databases.push(reopened)
    const reopenedInputs = new UniversalInputService(reopened, async kind => ({ canceled: false, path: selected, kind }))
    const reopenedProjects = new ProjectContextService(reopened, reopenedInputs)
    await reopenedProjects.ensurePersonalInbox(path.join(root, 'personal-inbox'))
    const reopenedTasks = new TaskManager(reopened, new ArtifactService(reopened), reopenedInputs)
    const restoredService = new FileOrganizerService(reopened, reopenedTasks)
    await expect(restoredService.undo(plan.id)).rejects.toThrow('UNDO_REAUTHORIZATION_REQUIRED')
    const reauthorized = await reopenedInputs.select('directory', true)
    const restored = await restoredService.undo(plan.id, reauthorized.asset!.asset.id)
    expect(restored.status).toBe('undone')
    expect(await readFile(path.join(selected, 'lesson.pdf'), 'utf8')).toBe('local content')
  })

  it('rejects a different folder during undo reauthorization', async () => {
    const { selected, service, inputs } = await fixture()
    const wrong = await mkdtemp(path.join(os.tmpdir(), 'personal-workbench-wrong-root-')); selectedRoots.push(wrong)
    await writeFile(path.join(selected, 'notes.txt'), 'unchanged', 'utf8')
    const initial = await inputs.select('directory', true)
    const plan = await service.scan({ input_asset_id: initial.asset!.asset.id, mode: 'light' })
    service.approve(plan.id, plan.operations.filter(operation => operation.type === 'move').map(operation => operation.id))
    await service.execute(plan.id)
    const wrongInputs = new UniversalInputService(service.database, async kind => ({ canceled: false, path: wrong, kind }))
    const wrongSelection = await wrongInputs.select('directory', true)
    await expect(service.undo(plan.id, wrongSelection.asset!.asset.id)).rejects.toThrow('UNDO_ROOT_MISMATCH')
    expect(await readFile(path.join(selected, '笔记', 'notes.txt'), 'utf8')).toBe('unchanged')
    expect(service.tasks.events(plan.task_id).some(event => event.eventType === 'organization.undo_rejected' && (event.payload as { reason?: string }).reason === 'UNDO_ROOT_MISMATCH')).toBe(true)
  })

  it('does not execute a draft plan or allow a destination outside the selected root', async () => {
    const { selected, service, inputs, database } = await fixture()
    await writeFile(path.join(selected, 'note.txt'), 'safe', 'utf8')
    const picked = await inputs.select('directory', true)
    const plan = await service.scan({ input_asset_id: picked.asset!.asset.id })
    await expect(service.execute(plan.id)).rejects.toThrow('ORGANIZATION_PLAN_NOT_APPROVED')
    const forged = service.approve(plan.id)
    forged.operations.find(operation => operation.type === 'move')!.destination_relative_path = '..\\outside.txt'
    database.db.prepare('UPDATE file_organization_plans SET operations_json=? WHERE id=?').run(JSON.stringify(forged.operations), forged.id)
    const result = await service.execute(forged.id)
    expect(result.operations.some(operation => operation.error === 'ORGANIZER_DESTINATION_DENIED')).toBe(true)
    await expect(stat(path.join(selected, 'note.txt'))).resolves.toBeDefined()
  })

  it('uses a bounded local text sample for smart topic suggestions and keeps a reusable profile', async () => {
    const { selected, service, inputs, database } = await fixture()
    await writeFile(path.join(selected, 'python-lesson.md'), '# Python lesson\nFunctions and variables are basic programming concepts.', 'utf8')
    const first = await inputs.select('directory', true)
    const plan = await service.scan({ input_asset_id: first.asset!.asset.id, mode: 'smart' })
    expect(plan.operations.some(operation => operation.destination_relative_path.toLowerCase().includes(path.join('笔记', 'python lesson').toLowerCase()))).toBe(true)
    expect(Number((database.db.prepare('SELECT COUNT(*) AS count FROM file_content_profiles').get() as { count: number }).count)).toBe(1)
  })

  it('only proposes an image name optimization when requested and keeps the extension', async () => {
    const { selected, service, inputs } = await fixture()
    await writeFile(path.join(selected, 'IMG_1234.jpg'), 'image-data', 'utf8')
    const picked = await inputs.select('directory', true)
    const plan = await service.scan({ input_asset_id: picked.asset!.asset.id, mode: 'smart', optimize_names: true })
    const operation = plan.operations.find(item => item.source_relative_path === 'IMG_1234.jpg')!
    expect(operation.destination_relative_path).toMatch(/图片-01\.jpg$/u)
    expect(operation.reason).toContain('扩展名')
  })

  it('applies a local user rule before deterministic classification without widening the selected root', async () => {
    const { selected, service, inputs } = await fixture()
    service.createRule({ pattern: '*.pdf', destination_relative_path: '课程资料/高数' })
    await writeFile(path.join(selected, 'chapter.pdf'), 'course material', 'utf8')
    const picked = await inputs.select('directory', true)
    const plan = await service.scan({ input_asset_id: picked.asset!.asset.id, mode: 'light' })
    const operation = plan.operations.find(item => item.source_relative_path === 'chapter.pdf')!
    expect(operation.destination_relative_path).toBe(path.join('课程资料', '高数', 'chapter.pdf'))
    expect(operation.reason).toContain('本地整理规则')
    expect(() => service.createRule({ pattern: '*.txt', destination_relative_path: '../outside' })).toThrow('ORGANIZER_DESTINATION_DENIED')
  })

  it('does not send ordinary photo names to local OCR', async () => {
    const resolver = new OrganizerContentResolver()
    await expect(resolver.resolveCandidateImageText({ absolutePath: path.join(os.tmpdir(), 'holiday.jpg'), relativePath: 'holiday.jpg', taskId: 'test', index: 0 })).resolves.toBeNull()
  })

  it('validates local model classifications and allows only a safe draft target edit', async () => {
    const accepted = validateOrganizerClassifications([{ file_key: 'a', category: '学习资料', topic: '数学', reason: '有限摘要包含矩阵。', certainty: 'medium' }, { file_key: 'b', category: '学习资料', topic: '..', reason: 'bad', certainty: 'high' }], new Set(['a', 'b']))
    expect(accepted).toHaveLength(2); expect(accepted[0]?.topic).toBe('数学'); expect(accepted[1]?.topic).toBeNull()
    const completed = completeOrganizerClassifications([{ file_key: 'a', category: '学习资料', topic: '数学', reason: '有限摘要包含矩阵。', certainty: 'medium' }], new Set(['a', 'missing']))
    expect(completed).toHaveLength(2)
    expect(completed.find(item => item.file_key === 'missing')).toMatchObject({ category: '待整理', topic: null, certainty: 'low' })
    const { selected, service, inputs } = await fixture(); await writeFile(path.join(selected, 'note.txt'), 'safe', 'utf8')
    const picked = await inputs.select('directory', true); const plan = await service.scan({ input_asset_id: picked.asset!.asset.id })
    const operation = plan.operations.find(item => item.type === 'move')!
    expect(service.updateOperationDestination(plan.id, operation.id, '课程资料/高数').operations.find(item => item.id === operation.id)?.destination_relative_path).toBe(path.join('课程资料', '高数', 'note.txt'))
    expect(() => service.updateOperationDestination(plan.id, operation.id, '../outside')).toThrow('ORGANIZER_DESTINATION_DENIED')
  })

  it('keeps an uncertain file in place until the user explicitly adds it to the draft plan', async () => {
    const { selected, service, inputs } = await fixture(); await writeFile(path.join(selected, 'x.unknown'), 'unclassified', 'utf8')
    const picked=await inputs.select('directory',true); const plan=await service.scan({input_asset_id:picked.asset!.asset.id,mode:'smart'})
    const waiting=((plan.scan.needs_confirmation??[]) as Array<{source_relative_path:string}>).find(item=>item.source_relative_path==='x.unknown')
    expect(waiting).toBeDefined(); expect(plan.operations.some(item=>item.source_relative_path==='x.unknown')).toBe(false)
    const updated=await service.addPendingOperations(plan.id,[{source_relative_path:'x.unknown',destination_relative_path:'待整理/已确认'}])
    expect(updated.operations.some(item=>item.destination_relative_path===path.join('待整理','已确认','x.unknown'))).toBe(true)
  })

  it('does not overwrite a file changed after organization during undo', async () => {
    const { selected, service, inputs } = await fixture(); await writeFile(path.join(selected,'note.txt'),'original','utf8'); await writeFile(path.join(selected,'photo.jpg'),'image','utf8')
    const initial=await inputs.select('directory',true); const plan=await service.scan({input_asset_id:initial.asset!.asset.id,mode:'light'}); service.approve(plan.id,plan.operations.filter(item=>item.type==='move').map(item=>item.id)); await service.execute(plan.id)
    await writeFile(path.join(selected,'笔记','note.txt'),'changed','utf8'); const grant=await inputs.select('directory',true); const result=await service.undo(plan.id,grant.asset!.asset.id)
    expect(result.status).toBe('completed_with_errors'); expect(await readFile(path.join(selected,'笔记','note.txt'),'utf8')).toBe('changed'); expect(await readFile(path.join(selected,'photo.jpg'),'utf8')).toBe('image')
    expect(service.tasks.events(plan.task_id).some(event => event.eventType === 'organization.undo_completed' && (event.payload as { status?: string }).status === 'completed_with_errors')).toBe(true)
  })
})
