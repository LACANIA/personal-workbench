/**
 * Framework-neutral TypeScript adaptation of selected data-only contracts from
 * the user's Video2Skill repository at commit ddadb0a1d66e58acfc0ba468dc62bff8dc64ba42.
 * No legacy process, network, media, credential, or desktop path dependency is retained.
 */

export const LEGACY_VIDEO_TASK_STATES = [
  'CREATED', 'INSPECTING', 'ACQUIRING', 'TRANSCRIBING', 'ANALYZING',
  'PACKAGING', 'AUDITING', 'COMPLETED', 'PAUSED', 'FAILED',
] as const

export type LegacyVideoTaskState = typeof LEGACY_VIDEO_TASK_STATES[number]

export interface LegacyArtifactContract {
  artifactId: string
  kind: string
  relativePath: string
  mediaType?: string
  sha256?: string
}

export interface LegacyTaskManifestContract {
  taskId: string
  sourceKind: 'local-file' | 'url'
  sourceValue: string
  state: LegacyVideoTaskState
  artifacts: LegacyArtifactContract[]
  createdAt: string
  updatedAt: string
}

export interface LegacyToolResultContract<T = unknown> {
  ok: boolean
  value?: T
  errorCode?: string
  errorMessage?: string
  artifacts: LegacyArtifactContract[]
}

export const LEGACY_VIDEO_TRANSITIONS: Readonly<Record<LegacyVideoTaskState, readonly LegacyVideoTaskState[]>> = {
  CREATED: ['INSPECTING', 'FAILED'],
  INSPECTING: ['ACQUIRING', 'PAUSED', 'FAILED'],
  ACQUIRING: ['TRANSCRIBING', 'PAUSED', 'FAILED'],
  TRANSCRIBING: ['ANALYZING', 'PAUSED', 'FAILED'],
  ANALYZING: ['PACKAGING', 'PAUSED', 'FAILED'],
  PACKAGING: ['AUDITING', 'PAUSED', 'FAILED'],
  AUDITING: ['COMPLETED', 'PAUSED', 'FAILED'],
  COMPLETED: [],
  PAUSED: ['INSPECTING', 'ACQUIRING', 'TRANSCRIBING', 'ANALYZING', 'PACKAGING', 'AUDITING', 'FAILED'],
  FAILED: [],
}

export function allowsLegacyTransition(from: LegacyVideoTaskState, to: LegacyVideoTaskState): boolean {
  return LEGACY_VIDEO_TRANSITIONS[from].includes(to)
}
