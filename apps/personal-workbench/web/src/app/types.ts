import type { DistributionStatus, PortableWorkbenchConfig, ProjectContextView } from '../../../shared/contracts/index.ts'

export type PageId = 'workbench' | 'organizer' | 'projects' | 'reviews' | 'review-history' | 'tasks' | 'memory' | 'video' | 'settings'

export interface AppSnapshot {
  health: Record<string, unknown> | null
  capabilities: Record<string, unknown> | null
  models: Record<string, unknown> | null
  profiles: unknown[]
  workspaces: { allowedRoots: string[]; recent: string[] }
  projects: Record<string, unknown>[]
  projectContexts: ProjectContextView[]
  memory: Record<string, unknown> | null
  documentSearch: Record<string, unknown> | null
  legacy: Record<string, unknown> | null
  localConfig: PortableWorkbenchConfig | null
  distribution: DistributionStatus | null
}
