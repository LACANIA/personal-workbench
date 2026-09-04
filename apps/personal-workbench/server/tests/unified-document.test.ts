import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/database.ts'
import { ProjectContextService } from '../src/projects/service.ts'
import { TaskManager } from '../src/tasks/manager.ts'
import { UniversalInputService } from '../src/input/service.ts'
import { PATHS } from '../src/config.ts'

const roots: string[] = []
const databases: WorkbenchDatabase[] = []
afterEach(async () => { for (const database of databases.splice(0)) database.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('STEP-34 UnifiedDocument', () => {
  it('persists web content additively, keeps task/project isolation and passes database checks', async () => {
    const boundary = path.join(PATHS.appRoot, 'data', 'test-runtime')
    await mkdir(boundary, { recursive: true })
    const root = await mkdtemp(path.join(boundary, 'step34-unified-'))
    roots.push(root)
    const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
    databases.push(database)
    const inputs = new UniversalInputService(database)
    const projects = new ProjectContextService(database, inputs)
    const inbox = await projects.ensurePersonalInbox(path.join(root, 'inbox'))
    const tasks = new TaskManager(database, undefined, inputs)
    const task = tasks.create({ templateId: 'knowledge-ingestion', inputType: 'web_url', inputValue: 'https://example.com/article', workspacePath: inbox.rootPath, projectName: inbox.name })
    const content = '公开网页资料，包含足够的正文内容，用于验证统一文档写入后可以由学习资料服务读取。'
    const document = database.createUnifiedDocument({ id: randomUUID(), task_id: task.id, project_id: inbox.id, source_type: 'web_url', source_url: 'https://example.com/article', canonical_url: 'https://example.com/article', title: '示例网页', author: null, site_name: 'Example', description: null, language: 'zh-CN', content_type: 'text/html', content, sections: [{ heading: '正文', level: 1, text: content, source_anchor: 'content' }], code_blocks: [], links: [], metadata: { source_artifact_ids: [] }, acquired_at: new Date().toISOString(), content_sha256: 'a'.repeat(64) })
    expect(database.getUnifiedDocumentByTask(task.id)).toMatchObject({ id: document.id, title: '示例网页' })
    expect(database.findUnifiedDocumentByIdentity(inbox.id, 'https://example.com/article', 'a'.repeat(64))?.id).toBe(document.id)
    expect(database.runtimeIntegrity()).toEqual({ integrity_check: 'ok', foreign_key_check: [] })
  })
})
