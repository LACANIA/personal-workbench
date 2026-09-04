import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  DatabaseRole,
  ProjectActionType,
  ProjectContext,
  ProjectContextView,
  ProjectDetection,
  ProjectRecommendedAction,
  ProjectRegisterInput,
  ProjectSnapshotHistoryItem,
  ProjectTimelineEvent,
  ProjectType,
} from '../../../shared/contracts/index.ts'
import { collectAssetInventory } from '../assets/inventory.ts'
import { PATHS } from '../config.ts'
import { WorkbenchDatabase } from '../database.ts'
import { UniversalInputService } from '../input/service.ts'
import { listProjects } from '../memory/service.ts'
import { assertAllowedExisting } from '../security/path-policy.ts'
import { ProjectChangeService } from './change-service.ts'
import { ProjectTimelineService } from './timeline-service.ts'

export const PERSONAL_INBOX_NAME = 'Personal Inbox'
export const PERSONAL_INBOX_DESCRIPTION = '接收没有明确项目归属的临时分析任务与经用户确认保存的报告。'

function text(value: unknown, maximum: number, fallback = ''): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error('INVALID_PROJECT_INPUT')
  const normalized = value.trim()
  if (normalized.length > maximum) throw new Error('INVALID_PROJECT_INPUT')
  return normalized
}

export async function detectProjectType(rootPath: string): Promise<{ projectType: ProjectType; signals: ProjectDetection }> {
  const entries = await readdir(rootPath, { withFileTypes: true })
  const names = entries.map(entry => entry.name.toLowerCase())
  const signals: ProjectDetection = {
    hasSrc: entries.some(entry => entry.isDirectory() && entry.name.toLowerCase() === 'src'),
    hasDocs: entries.some(entry => entry.isDirectory() && entry.name.toLowerCase() === 'docs'),
    hasReadme: names.some(name => /^readme(?:\.|$)/u.test(name)),
    hasPackageJson: names.includes('package.json'),
    hasPyprojectToml: names.includes('pyproject.toml'),
    hasPdf: entries.some(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')),
  }
  let projectType: ProjectType = 'general'
  if (signals.hasPackageJson && signals.hasPyprojectToml) projectType = 'mixed'
  else if (signals.hasPackageJson) projectType = 'node'
  else if (signals.hasPyprojectToml) projectType = 'python'
  else if (signals.hasPdf) projectType = 'research'
  else if (signals.hasSrc) projectType = 'software'
  else if (signals.hasDocs || signals.hasReadme) projectType = 'documentation'
  return { projectType, signals }
}

function compatibilityRecommendedLabels(project: ProjectContext, signals: ProjectDetection | null, memoryReferenceCount: number): string[] {
  const actions = ['资产清单', '文件分析']
  if (signals?.hasReadme === true || signals?.hasDocs === true) actions.push('项目总结')
  if (signals?.hasPackageJson === true || signals?.hasPyprojectToml === true) actions.push('开发环境核验')
  if (memoryReferenceCount > 0) actions.push('项目记忆查询')
  if (project.projectType === 'research' || signals?.hasPdf === true) actions.push('文档证据检索')
  return [...new Set(actions)]
}

function projectActions(project: ProjectContext): ProjectRecommendedAction[] {
  const action = (actionType: ProjectActionType, label: string, payload: Record<string, unknown>): ProjectRecommendedAction => ({
    action_type: actionType,
    label,
    payload,
  })
  return [
    action('create_task', '创建资产清单任务', {
      templateId: 'asset-inventory',
      title: `${project.name} · 资产清单`,
      inputType: 'directory',
      inputValue: project.rootPath,
      workspacePath: project.rootPath,
      projectName: project.name,
    }),
    action('rescan_project', '重新扫描项目', { projectId: project.id }),
    action('generate_report', '创建项目报告任务', {
      templateId: 'project-summary',
      title: `${project.name} · 项目状态报告`,
      inputType: 'question',
      inputValue: `总结项目 ${project.name} 的当前状态，引用项目记忆和许可范围内的文件证据。`,
      workspacePath: project.rootPath,
      projectName: project.name,
    }),
  ]
}

export class ProjectContextService {
  readonly changes: ProjectChangeService
  readonly timelineService: ProjectTimelineService

  constructor(readonly database: WorkbenchDatabase, readonly inputs = new UniversalInputService(database)) {
    this.changes = new ProjectChangeService(database)
    this.timelineService = new ProjectTimelineService(database)
  }

  async ensurePersonalInbox(rootPath = PATHS.personalInbox): Promise<ProjectContext> {
    await mkdir(rootPath, { recursive: true })
    const canonicalRoot = await assertAllowedExisting(rootPath, 'directory')
    const byRoot = this.database.getProjectContextByRoot(canonicalRoot)
    if (byRoot !== undefined) {
      if (byRoot.name !== PERSONAL_INBOX_NAME || byRoot.projectType !== 'personal') throw new Error('PERSONAL_INBOX_ROOT_CONFLICT')
      return byRoot
    }
    const byName = this.database.getProjectContextByName(PERSONAL_INBOX_NAME)
    if (byName !== undefined) throw new Error('PERSONAL_INBOX_NAME_CONFLICT')
    return this.database.createProjectContext(randomUUID(), {
      name: PERSONAL_INBOX_NAME,
      rootPath: canonicalRoot,
      description: PERSONAL_INBOX_DESCRIPTION,
      projectType: 'personal',
    })
  }

  async register(input: ProjectRegisterInput): Promise<ProjectContextView> {
    if (input === null || typeof input !== 'object') throw new Error('INVALID_PROJECT_INPUT')
    const rootPath = text(input.rootPath, 1024)
    if (rootPath.length === 0) throw new Error('INVALID_PROJECT_INPUT')
    const canonicalRoot = input.inputAssetId === undefined
      ? await assertAllowedExisting(rootPath, 'directory')
      : await this.inputs.authorizedProjectRoot(input.inputAssetId)
    const submittedCanonicalRoot = input.inputAssetId === undefined ? canonicalRoot : await realpath(rootPath)
    if (input.inputAssetId !== undefined && path.resolve(submittedCanonicalRoot).toLowerCase() !== path.resolve(canonicalRoot).toLowerCase()) {
      throw new Error('PROJECT_INPUT_PATH_MISMATCH')
    }
    const existing = this.database.getProjectContextByRoot(canonicalRoot)
    if (existing !== undefined) {
      if (input.inputAssetId !== undefined) this.inputs.promoteToProject(input.inputAssetId, existing.id)
      return this.detail(existing.id)
    }
    const detection = await detectProjectType(canonicalRoot)
    const name = text(input.name, 160, path.basename(canonicalRoot)) || path.basename(canonicalRoot)
    const description = text(input.description, 1000)
    const project = this.database.createProjectContext(randomUUID(), {
      name,
      rootPath: canonicalRoot,
      description,
      projectType: detection.projectType,
    })
    if (input.inputAssetId !== undefined) this.inputs.promoteToProject(input.inputAssetId, project.id)
    this.database.linkExistingTasksToProject(project.id)
    this.syncMemoryReferences(project)
    return this.detail(project.id)
  }

  async scan(id: string): Promise<ProjectContextView> {
    const project = this.required(id)
    const [inventory, detection] = await Promise.all([
      collectAssetInventory(project.rootPath, { authorizedRoot: project.rootPath }),
      detectProjectType(project.rootPath),
    ])
    const scannedAt = new Date().toISOString()
    this.database.saveProjectAssetSnapshot(randomUUID(), id, inventory, detection.signals, scannedAt)
    this.database.updateProjectAfterScan(id, project.projectType === 'personal' ? 'personal' : detection.projectType, scannedAt)
    this.database.linkExistingTasksToProject(id)
    this.syncMemoryReferences(this.required(id))
    return this.detail(id)
  }

  list(): ProjectContextView[] {
    return this.database.listProjectContexts().map(project => this.hydrate(project))
  }

  detail(id: string): ProjectContextView {
    return this.hydrate(this.required(id))
  }

  history(id: string, limit = 100): ProjectSnapshotHistoryItem[] {
    const project = this.required(id)
    return this.database.listProjectAssetSnapshots(project.id, limit).map(snapshot => ({
      snapshot_id: snapshot.id,
      scan_time: snapshot.createdAt,
      file_count: snapshot.fileCount,
      directory_count: snapshot.directoryCount,
      total_bytes: snapshot.totalBytes,
      extension_summary: snapshot.extensionDistribution,
    }))
  }

  timeline(id: string, limit = 100): ProjectTimelineEvent[] {
    return this.timelineService.list(this.required(id), limit)
  }

  linkMemory(id: string, memoryProjectId: string, requestedRole?: DatabaseRole): ProjectContextView {
    const project = this.required(id)
    const normalizedId = text(memoryProjectId, 128)
    if (normalizedId.length === 0) throw new Error('INVALID_MEMORY_PROJECT_ID')
    const roles: DatabaseRole[] = requestedRole === undefined ? ['production', 'test'] : [requestedRole]
    const matches = roles.flatMap(role => listProjects(role)
      .filter(row => String(row.id) === normalizedId)
      .map(row => ({ role, row })))
    if (matches.length === 0) throw new Error('MEMORY_PROJECT_NOT_FOUND')
    if (matches.length > 1) throw new Error('MEMORY_PROJECT_AMBIGUOUS')
    const match = matches[0]!
    this.database.upsertProjectMemoryReference({
      id: randomUUID(),
      projectId: project.id,
      memoryRole: match.role,
      memoryProjectName: String(match.row.name),
      memoryEntityType: 'project',
      memoryEntityId: String(match.row.id),
    })
    return this.detail(project.id)
  }

  unlinkMemory(id: string, memoryProjectId: string, requestedRole?: DatabaseRole): ProjectContextView {
    const project = this.required(id)
    const normalizedId = text(memoryProjectId, 128)
    if (normalizedId.length === 0) throw new Error('INVALID_MEMORY_PROJECT_ID')
    const removed = this.database.deleteProjectMemoryReference(project.id, normalizedId, requestedRole)
    if (removed === 0) throw new Error('MEMORY_LINK_NOT_FOUND')
    return this.detail(project.id)
  }

  private required(id: string): ProjectContext {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const project = this.database.getProjectContext(id)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    return project
  }

  private hydrate(project: ProjectContext): ProjectContextView {
    const assetStats = this.database.getLatestProjectAssetSnapshot(project.id)
    const memoryReferences = this.database.listProjectMemoryReferences(project.id)
    return {
      ...project,
      assetStats,
      recentTasks: this.database.listProjectTasks(project.id, 8),
      taskCount: this.database.countProjectTasks(project.id),
      memoryReferenceCount: memoryReferences.length,
      memoryReferences,
      changeSummary: this.changes.summarize(project.id),
      actions: projectActions(project),
      recommendedActions: compatibilityRecommendedLabels(project, assetStats?.detectedSignals ?? null, memoryReferences.length),
    }
  }

  private syncMemoryReferences(project: ProjectContext): void {
    for (const role of ['production', 'test'] as const satisfies readonly DatabaseRole[]) {
      for (const memoryProject of listProjects(role)) {
        if (String(memoryProject.name).localeCompare(project.name, undefined, { sensitivity: 'accent' }) !== 0) continue
        this.database.upsertProjectMemoryReference({
          id: randomUUID(),
          projectId: project.id,
          memoryRole: role,
          memoryProjectName: String(memoryProject.name),
          memoryEntityType: 'project',
          memoryEntityId: String(memoryProject.id),
        })
      }
    }
  }
}
