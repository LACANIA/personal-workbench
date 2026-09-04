export const VIDEO_TASK_STATES = [
  'CREATED',
  'INSPECTING',
  'ACQUIRING',
  'TRANSCRIBING',
  'ANALYZING',
  'PACKAGING',
  'AUDITING',
  'COMPLETED',
  'PAUSED',
  'FAILED',
] as const

export type VideoTaskState = typeof VIDEO_TASK_STATES[number]

export interface LegacyTaskManifest {
  taskId: string
  sourceKind: 'local-file' | 'url'
  sourceValue: string
  state: VideoTaskState
  artifacts: LegacyArtifact[]
  createdAt: string
  updatedAt: string
}

export interface LegacyArtifact {
  artifactId: string
  kind: string
  relativePath: string
  mediaType?: string
  sha256?: string
}

export interface LegacyToolResult<T = unknown> {
  ok: boolean
  value?: T
  errorCode?: string
  errorMessage?: string
  artifacts: LegacyArtifact[]
}

export const VIDEO_STATE_TRANSITIONS: Readonly<Record<VideoTaskState, readonly VideoTaskState[]>> = {
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

export function canTransitionVideoTask(from: VideoTaskState, to: VideoTaskState): boolean {
  return VIDEO_STATE_TRANSITIONS[from].includes(to)
}
