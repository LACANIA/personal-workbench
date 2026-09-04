import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { TaskManager } from '../src/tasks/manager.ts'

const roots: string[] = []

describe('STEP-36.5 document cancellation and resume', () => {
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

  it('keeps a completed source resumable when its output phase is cancelled', async () => {
    const root = path.join(PATHS.appRoot, 'data', 'test-runtime', `step365-${randomUUID()}`); roots.push(root)
    await mkdir(path.join(root, 'output'), { recursive: true })
    const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
    database.createProjectContext('project', { name: '资料', rootPath: root, description: '', projectType: 'general' })
    const id = randomUUID()
    database.createTask(id, { templateId: 'file-analysis', inputType: 'file', inputValue: 'document.pdf', workspacePath: root, projectName: '资料', title: '长资料' })
    database.bindTaskToProject(id, 'project', root)
    database.updateTask(id, { status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), resultText: '来源已经解析。' })
    const tasks = new TaskManager(database, new ArtifactService(database))
    tasks.updateRuntime(id, { current_stage: 'learning_document_generating', progress: 89, status: 'running', message: '正在组织章节和复习问题。' })
    await tasks.cancel(id)
    expect(database.getTask(id)?.status).toBe('canceled')
    expect(tasks.runtime(id).status).toBe('canceled')
    tasks.resumeDocumentOutput(id)
    expect(database.getTask(id)?.status).toBe('completed')
    expect(tasks.events(id).some(event => event.eventType === 'document.resume')).toBe(true)
    database.db.close()
  })
})
