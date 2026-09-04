import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactIntelligenceService } from '../src/artifacts/intelligence-service.ts'
import { ArtifactEvidenceService } from '../src/artifacts/evidence-service.ts'
import { ArtifactService } from '../src/artifacts/service.ts'
import { PATHS } from '../src/config.ts'
import { WorkbenchDatabase } from '../src/database.ts'
import { ProjectContextService } from '../src/projects/service.ts'
import { TaskManager } from '../src/tasks/manager.ts'
import { readDocxDocumentXml, validateDocx } from '../src/reports/docx.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(`${PATHS.appRoot}${path.sep}data${path.sep}test-runtime${path.sep}`)) throw new Error('unsafe artifact intelligence cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(): Promise<{
  root: string
  database: WorkbenchDatabase
  artifacts: ArtifactService
  intelligence: ArtifactIntelligenceService
  projects: ProjectContextService
  projectId: string
}> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID())
  await mkdir(path.join(root, 'output'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"artifact-intelligence"}', 'utf8')
  temporaryRoots.push(root)
  const database = new WorkbenchDatabase(path.join(root, 'workbench.db'))
  const artifacts = new ArtifactService(database, new ArtifactEvidenceService(database))
  const projects = new ProjectContextService(database)
  const project = await projects.register({ rootPath: root, name: 'Artifact Intelligence Fixture' })
  return { root, database, artifacts, intelligence: new ArtifactIntelligenceService(database, artifacts), projects, projectId: project.id }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('Artifact preview', () => {
  it('returns a read-only Markdown preview', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'preview.md'); const content = '# Preview\n只读内容'
    await writeFile(file, content, 'utf8'); const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file })
    await expect(test.intelligence.preview(artifact.id)).resolves.toMatchObject({ preview_type: 'text', content, truncated: false, mime: 'text/markdown' })
    expect(await readFile(file, 'utf8')).toBe(content); test.database.close()
  })

  it('returns JSON as bounded text without changing it', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'preview.json'); const content = '{"status":"ok"}'
    await writeFile(file, content, 'utf8'); const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file, artifact_type: 'dataset' })
    const preview = await test.intelligence.preview(artifact.id)
    expect(preview).toMatchObject({ preview_type: 'text', content, truncated: false, mime: 'application/json' }); test.database.close()
  })

  it('truncates text after 100 KiB', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'large.txt'); await writeFile(file, 'x'.repeat(110 * 1024), 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file })
    const preview = await test.intelligence.preview(artifact.id)
    expect(preview.truncated).toBe(true); expect(Buffer.byteLength(preview.content!, 'utf8')).toBe(100 * 1024); test.database.close()
  })

  it('extracts PNG dimensions without returning image bytes', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'image.png'); const png = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(640, 16); png.writeUInt32BE(360, 20)
    await writeFile(file, png); const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file })
    await expect(test.intelligence.preview(artifact.id)).resolves.toMatchObject({ preview_type: 'image', content: null, width: 640, height: 360, mime: 'image/png' }); test.database.close()
  })

  it('shows source code as text and never executes it', async () => {
    const test = await fixture(); const marker = path.join(test.root, 'executed.txt'); const file = path.join(test.root, 'output', 'sample.js')
    await writeFile(file, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`, 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file })
    const preview = await test.intelligence.preview(artifact.id)
    expect(preview.preview_type).toBe('code'); await expect(readFile(marker, 'utf8')).rejects.toThrow(); test.database.close()
  })

  it('rejects unsupported binary previews', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'unknown.bin'); await writeFile(file, Buffer.from([0, 1, 2, 3]))
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file })
    await expect(test.intelligence.preview(artifact.id)).rejects.toThrow('ARTIFACT_PREVIEW_UNSUPPORTED'); test.database.close()
  })
})

describe('Artifact versions and health', () => {
  it('creates a v1 snapshot for every registered Artifact', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'report_v1.md'); await writeFile(file, '# v1', 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file, artifact_type: 'report' })
    expect(test.artifacts.history(artifact.id).versions).toEqual([expect.objectContaining({ artifact_id: artifact.id, version_number: 1, sha256: digest('# v1') })]); test.database.close()
  })

  it('links a new Artifact with the supersedes relation', async () => {
    const test = await fixture(); const firstFile = path.join(test.root, 'output', 'report_v1.md'); const secondFile = path.join(test.root, 'output', 'report_v2.md')
    await writeFile(firstFile, '# v1', 'utf8'); await writeFile(secondFile, '# v2', 'utf8')
    const first = await test.artifacts.register({ project_id: test.projectId, file_path: firstFile, artifact_type: 'report' })
    const second = await test.artifacts.register({ project_id: test.projectId, file_path: secondFile, artifact_type: 'report', supersedes_artifact_id: first.id, change_note: '第二版' })
    const history = test.artifacts.history(second.id)
    expect(history.version_count).toBe(2); expect(history.versions.map(row => row.version_number)).toEqual([1, 2])
    expect(history.links).toEqual([expect.objectContaining({ old_artifact_id: first.id, new_artifact_id: second.id, relation: 'supersedes' })])
    expect(test.projects.timeline(test.projectId)).toContainEqual(expect.objectContaining({ type: 'artifact_version_created', artifact_id: second.id, version_number: 2 })); test.database.close()
  })

  it('marks a changed file as outdated while preserving the registered hash', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'health.md'); await writeFile(file, 'before', 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file }); await writeFile(file, 'after', 'utf8')
    const result = await test.intelligence.check(artifact.id)
    expect(result).toMatchObject({ previous_hash: digest('before'), current_hash: digest('after'), status: 'outdated', observed_status: 'outdated' })
    expect(test.artifacts.get(artifact.id)).toMatchObject({ sha256: digest('before'), status: 'outdated' }); test.database.close()
  })

  it('marks a missing file without deleting its index', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'missing.md'); await writeFile(file, 'present', 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file }); await rm(file)
    const result = await test.intelligence.check(artifact.id)
    expect(result).toMatchObject({ current_hash: null, status: 'missing' }); expect(test.artifacts.get(artifact.id).status).toBe('missing'); test.database.close()
  })

  it('supports archived status and status filtering', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'archive.md'); await writeFile(file, 'archive', 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file }); await test.intelligence.setArchived(artifact.id, true)
    expect(test.artifacts.query({ project_id: test.projectId, status: 'archived' })).toHaveLength(1); test.database.close()
  })
})

describe('Task report and operating-system boundary', () => {
  it('saves an answer as a registered Markdown Artifact with Task Evidence', async () => {
    const test = await fixture(); const manager = new TaskManager(test.database, test.artifacts)
    const task = manager.create({ templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root, title: '验收报告' })
    test.database.updateTask(task.id, { status: 'completed', completedAt: new Date().toISOString(), resultText: '任务回答正文' })
    const result = await manager.saveAnswerAsReport(task.id)
    expect(result).toMatchObject({ file_created: true, artifact_registered: true, evidence_count: 1, candidate: { artifact_type: 'report', registered_artifact_id: result.artifact.id } })
    expect(await readFile(result.candidate.absolute_path, 'utf8')).toContain('任务回答正文')
    expect(test.artifacts.query({ task_id: task.id })).toEqual([expect.objectContaining({ id: result.artifact.id, project_id: test.projectId })])
    expect(test.database.listArtifactEvidenceLinks(result.artifact.id)).toEqual([expect.objectContaining({ source_type: 'task', source_id: task.id, relation_type: 'generated_from' })]); test.database.close()
  })

  it('exports the preserved Markdown report as a valid Word Artifact with Evidence', async () => {
    const test = await fixture(); const manager = new TaskManager(test.database, test.artifacts)
    const task = manager.create({ templateId: 'asset-inventory', inputType: 'directory', inputValue: test.root, workspacePath: test.root, projectName: 'Artifact Intelligence Fixture', title: 'Word 学习笔记' })
    test.database.updateTask(task.id, {
      status: 'completed', completedAt: new Date().toISOString(),
      resultText: '## 章节\n\n- 复习重点\n\n```ts\nconst answer = 42\n```\n\n| 项目 | 内容 |\n| --- | --- |\n| 状态 | 已完成 |',
    })
    const exported = await manager.exportAnswerAsWord(task.id)
    expect(exported.word_artifact).toMatchObject({ artifact_type: 'report', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    const document = await readFile(exported.word_path)
    expect(() => validateDocx(document)).not.toThrow()
    const xml = readDocxDocumentXml(document)
    expect(xml).toContain('Word 学习笔记')
    expect(xml).toContain('复习重点')
    expect(xml).toContain('const answer = 42')
    expect(test.database.listArtifactEvidenceLinks(exported.word_artifact.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: 'task', source_id: task.id, relation_type: 'generated_from' }),
      expect.objectContaining({ source_type: 'artifact', source_id: exported.markdown_artifact.id, relation_type: 'derived_from' }),
    ]))
    expect(test.artifacts.query({ task_id: task.id, artifact_type: 'report' })).toHaveLength(2)
    test.database.close()
  })

  it('opens only a registered and permitted location through the injected fixed handler', async () => {
    const test = await fixture(); const file = path.join(test.root, 'output', 'open.md'); await writeFile(file, 'open', 'utf8')
    const artifact = await test.artifacts.register({ project_id: test.projectId, file_path: file }); const opened: string[] = []
    const service = new ArtifactIntelligenceService(test.database, test.artifacts, async canonical => { opened.push(canonical) })
    await expect(service.openLocation(artifact.id)).resolves.toMatchObject({ artifact_id: artifact.id, opened: true }); expect(opened).toEqual([artifact.absolute_path])
    test.database.db.prepare('UPDATE artifacts SET absolute_path = ? WHERE id = ?').run('C:\\Windows\\System32\\drivers\\etc\\hosts', artifact.id)
    await expect(service.openLocation(artifact.id)).rejects.toThrow('PATH_POLICY_DENIED'); expect(opened).toHaveLength(1); test.database.close()
  })

  it('migrates an old STEP-18 Artifact row to active status and a v1 snapshot', async () => {
    const root = path.join(PATHS.appRoot, 'data', 'test-runtime', randomUUID()); await mkdir(root, { recursive: true }); temporaryRoots.push(root)
    const file = path.join(root, 'legacy.md'); await writeFile(file, 'legacy', 'utf8'); const databasePath = path.join(root, 'legacy.db'); const raw = new DatabaseSync(databasePath)
    raw.exec(`
      CREATE TABLE project_contexts(id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, description TEXT NOT NULL, project_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_scan_at TEXT);
      CREATE TABLE artifacts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, artifact_type TEXT NOT NULL, name TEXT NOT NULL, relative_path TEXT NOT NULL, absolute_path TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, metadata_json TEXT NOT NULL);
    `)
    raw.prepare('INSERT INTO project_contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-project', 'Legacy', root, '', 'general', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z', null)
    raw.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-artifact', 'legacy-project', null, 'report', 'legacy.md', 'legacy.md', file, 'text/markdown', 6, digest('legacy'), '2026-08-21T00:00:00.000Z', '{}'); raw.close()
    const migrated = new WorkbenchDatabase(databasePath); const artifact = migrated.getArtifact('legacy-artifact')!
    expect(artifact).toMatchObject({ status: 'active', version_count: 1 }); expect(migrated.listArtifactVersions(['legacy-artifact'])).toHaveLength(1)
    expect(migrated.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }); migrated.close()
  })
})
