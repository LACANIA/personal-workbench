import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { PERSONAL_INBOX_NAME, ProjectContextService } from '../src/projects/service.ts'
import { TaskManager } from '../src/tasks/manager.ts'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', `personal-inbox-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const boundary = `${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`
    if (!root.startsWith(boundary)) throw new Error('unsafe personal inbox cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

describe('STEP-26.5 Personal Inbox', () => {
  it('creates one idempotent personal Project Context', async () => {
    const root = await temporaryRoot()
    const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
    const projects = new ProjectContextService(database)
    const inboxRoot = path.join(root, 'inbox')
    const first = await projects.ensurePersonalInbox(inboxRoot)
    const second = await projects.ensurePersonalInbox(inboxRoot)
    expect(first).toMatchObject({ name: PERSONAL_INBOX_NAME, projectType: 'personal', rootPath: inboxRoot })
    expect(second.id).toBe(first.id)
    expect(database.listProjectContexts().filter(item => item.name === PERSONAL_INBOX_NAME)).toHaveLength(1)
    database.close()
  })

  it('binds a temporary package.json File Analysis task to Personal Inbox', async () => {
    const root = await temporaryRoot()
    const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
    const projects = new ProjectContextService(database)
    const inbox = await projects.ensurePersonalInbox(path.join(root, 'inbox'))
    const manager = new TaskManager(database, new ArtifactService(database, new ArtifactEvidenceService(database)))
    const task = manager.create({
      templateId: 'file-analysis',
      inputType: 'file',
      inputValue: path.join(PATHS.appRoot, 'package.json'),
    })
    expect(task).toMatchObject({ projectId: inbox.id, workspacePath: inbox.rootPath, projectName: PERSONAL_INBOX_NAME })
    database.close()
  })

  it('backfills a completed legacy task and saves Artifact plus Task and Session Evidence', async () => {
    const root = await temporaryRoot()
    const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
    const artifacts = new ArtifactService(database, new ArtifactEvidenceService(database))
    const manager = new TaskManager(database, artifacts)
    const legacy = database.createTask('legacy-file-analysis', {
      templateId: 'file-analysis',
      inputType: 'file',
      inputValue: path.join(PATHS.appRoot, 'package.json'),
    })
    expect(legacy).toMatchObject({ projectId: null, workspacePath: null })
    const inbox = await new ProjectContextService(database).ensurePersonalInbox(path.join(root, 'inbox'))
    database.updateTask(legacy.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      harnessSessionId: 'session-personal-inbox',
      resultText: 'packageManager 为 pnpm@11.7.0。',
    })

    const result = await manager.saveAnswerAsReport(legacy.id)
    const rebound = database.getTask(legacy.id)!
    expect(rebound).toMatchObject({ projectId: inbox.id, workspacePath: inbox.rootPath, projectName: PERSONAL_INBOX_NAME })
    expect(result).toMatchObject({ file_created: true, artifact_registered: true, evidence_count: 2 })
    expect(result.artifact).toMatchObject({ project_id: inbox.id, task_id: legacy.id, artifact_type: 'report' })
    expect(await readFile(result.artifact.absolute_path, 'utf8')).toContain('packageManager 为 pnpm@11.7.0。')
    expect(database.listArtifactEvidenceLinks(result.artifact.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: 'task', source_id: legacy.id, relation_type: 'generated_from' }),
      expect.objectContaining({ source_type: 'session', source_id: 'session-personal-inbox', relation_type: 'created_by' }),
    ]))
    expect(database.listEvents(legacy.id).map(event => event.eventType)).toEqual(expect.arrayContaining([
      'task.project_context_assigned', 'artifact.registered', 'artifact.report_saved',
    ]))
    database.close()
  })

  it('keeps an explicitly scoped File Analysis task in its selected project', async () => {
    const root = await temporaryRoot()
    const projectRoot = path.join(root, 'project')
    await mkdir(projectRoot, { recursive: true })
    const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
    const projects = new ProjectContextService(database)
    await projects.ensurePersonalInbox(path.join(root, 'inbox'))
    const project = await projects.register({ rootPath: projectRoot, name: 'Explicit Project' })
    const task = new TaskManager(database).create({
      templateId: 'file-analysis',
      inputType: 'file',
      inputValue: path.join(PATHS.appRoot, 'package.json'),
      workspacePath: project.rootPath,
      projectName: project.name,
    })
    expect(task).toMatchObject({ projectId: project.id, workspacePath: project.rootPath, projectName: project.name })
    database.close()
  })

  it('migrates the old project_type constraint without losing existing projects', async () => {
    const root = await temporaryRoot()
    const databasePath = path.join(root, 'legacy.db')
    const raw = new DatabaseSync(databasePath)
    raw.exec(`
      CREATE TABLE project_contexts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        project_type TEXT NOT NULL CHECK(project_type IN ('node','python','mixed','research','software','documentation','general')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_scan_at TEXT
      );
    `)
    raw.prepare('INSERT INTO project_contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-project', 'Legacy Project', root, '', 'general', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z', null,
    )
    raw.close()

    const database = new WorkbenchDatabase(databasePath)
    expect(database.getProjectContext('legacy-project')).toMatchObject({ name: 'Legacy Project', projectType: 'general' })
    const inbox = await new ProjectContextService(database).ensurePersonalInbox(path.join(root, 'inbox'))
    expect(inbox.projectType).toBe('personal')
    expect(String((database.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_contexts'").get() as { sql: string }).sql)).toContain("'personal'")
    expect(database.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(database.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    database.close()
  })
})
