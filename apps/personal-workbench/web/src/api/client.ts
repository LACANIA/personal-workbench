import type {
  ApiEnvelope,
  ArtifactCandidate,
  ArtifactEvidenceBundle,
  ArtifactEvidenceCreateInput,
  ArtifactEvidenceLinkRecord,
  ArtifactEvidenceSourceType,
  ArtifactEvidenceView,
  ArtifactEvidenceAuditReport,
  ArtifactHealthCheck,
  ArtifactHistory,
  ArtifactPreview,
  ArtifactQuery,
  ArtifactRecord,
  ArtifactProvenanceGraph,
  ArtifactProvenanceManifest,
  ArtifactReviewHistory,
  ArtifactRegisterInput,
  ArtifactType,
  ArtifactStatus,
  AsrGpuRuntimeDiagnostics,
  ProjectContextView,
  ProjectEvidenceAuditReport,
  ProjectEvidenceHealth,
  ProjectReviewQueue,
  ProjectReviewSummary,
  ProjectReviewHistory,
  ProjectProvenanceGraph,
  ProjectRegisterInput,
  ProjectSnapshotHistoryItem,
  ProjectTimelineEvent,
  TaskCreateInput,
  TaskEvent,
  TaskTemplate,
  TaskReportCandidateResult,
  TaskWordExportResult,
  ReviewDecision,
  ReviewDecisionRecord,
  ReviewerProfile,
  ReviewerRole,
  ReviewPolicy,
  ReviewPolicyType,
  ReviewSignatureEvaluation,
  ReviewChangeReport,
  ReviewRecheckResult,
  ReviewTimelineEvent,
  PortableWorkbenchConfig,
  BackupManifest,
  DistributionStatus,
  FirstRunStatus,
  FirstRunSmokeResult,
  InputAssetView,
  InputCapability,
  KnowledgeBenchmarkSummary,
  KnowledgeCardDetail,
  KnowledgeCardRecord,
  KnowledgeCardReviewDecision,
  KnowledgeExtractionDiagnostics,
  KnowledgeExtractionResult,
  KnowledgeIngestionInput,
  KnowledgeIngestionRecord,
  KnowledgeIngestionResult,
  LearningDocumentGenerateInput,
  LearningDocumentRecord,
  DetectedKnowledgeSource,
  UnifiedDocumentRecord,
  KnowledgeSourceAdapterHealth,
  MediaTempCleanupResult,
  MediaTempPreview,
  NativeInputSelection,
  VideoCapabilityStatus,
  VideoCreateInput,
  VideoJobRecord,
  VideoJobView,
  VideoPublishResult,
  VideoSearchResult,
  VideoSearchInput,
  RetrievalDiagnostics,
  RuntimeMonitor,
  TaskRuntimeView,
  WorkbenchTask,
} from '../../../shared/contracts/index.ts'

function loadToken(): string {
  const query = new URLSearchParams(window.location.search)
  const queryToken = query.get('token')
  if (queryToken !== null) {
    sessionStorage.setItem('workbench.token', queryToken)
    history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`)
    return queryToken
  }
  return sessionStorage.getItem('workbench.token') ?? ''
}

const token = loadToken()

function queryString(values: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) search.set(key, String(value))
  const rendered = search.toString()
  return rendered.length === 0 ? '' : `?${rendered}`
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Workbench-Token': token,
      ...init.headers,
    },
  })
  const envelope = await response.json() as ApiEnvelope<T>
  if (!response.ok || !envelope.ok || envelope.data === undefined) {
    throw new Error(envelope.error?.message ?? `HTTP ${response.status}`)
  }
  return envelope.data
}

async function rawJsonRequest<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { 'X-Workbench-Token': token } })
  const payload = await response.json() as T | ApiEnvelope<T>
  if (!response.ok) {
    const envelope = payload as ApiEnvelope<T>
    throw new Error(envelope.error?.message ?? `HTTP ${response.status}`)
  }
  return payload as T
}

/**
 * Uses fetch streaming rather than EventSource so the short-lived local token
 * remains in the request header and is never appended to an event URL.
 */
function streamTaskEvents(taskId: string, onEvent: (event: TaskEvent) => void, onError?: (error: Error) => void): () => void {
  const controller = new AbortController()
  void fetch(`/api/tasks/${encodeURIComponent(taskId)}/events`, {
    headers: { 'X-Workbench-Token': token }, signal: controller.signal,
  }).then(async response => {
    if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!controller.signal.aborted) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6)
        if (data !== undefined) {
          try { onEvent(JSON.parse(data) as TaskEvent) } catch { /* malformed frames are ignored */ }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  }).catch(error => {
    if (!controller.signal.aborted) onError?.(error instanceof Error ? error : new Error(String(error)))
  })
  return () => controller.abort()
}

export const api = {
  hasToken: token.length > 0,
  health: () => request<Record<string, unknown>>('/api/health'),
  runtimeMonitor: () => request<RuntimeMonitor>('/api/runtime/monitor'),
  capabilities: () => request<{ templates: TaskTemplate[]; step14Available: boolean }>('/api/capabilities'),
  inputCapabilities: () => request<{ max_stage_bytes: number; staged_extensions: string[]; matrix: InputCapability[] }>('/api/input/capabilities'),
  selectFile: () => window.personalWorkbenchDesktop?.selectFile()
    ?? request<NativeInputSelection>('/api/input/select-file', { method: 'POST', body: JSON.stringify({ user_action: true }) }),
  selectDirectory: () => window.personalWorkbenchDesktop?.selectDirectory()
    ?? request<NativeInputSelection>('/api/input/select-directory', { method: 'POST', body: JSON.stringify({ user_action: true }) }),
  inputAsset: (id: string) => request<InputAssetView>(`/api/input/assets/${encodeURIComponent(id)}`),
  deleteInputAsset: (id: string) => request<{ original_deleted: false; staged_copy_deleted: boolean }>(`/api/input/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  stageInput: async (file: File): Promise<InputAssetView> => {
    const response = await fetch('/api/input/stage', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Workbench-Token': token, 'X-Input-File-Name': encodeURIComponent(file.name) },
      body: file,
    })
    const envelope = await response.json() as ApiEnvelope<InputAssetView>
    if (!response.ok || !envelope.ok || envelope.data === undefined) throw new Error(envelope.error?.message ?? `HTTP ${response.status}`)
    return envelope.data
  },
  models: () => request<Record<string, unknown>>('/api/models'),
  localConfig: () => request<PortableWorkbenchConfig>('/api/config'),
  updateInterfaceMode: (interfaceMode: 'consumer' | 'advanced') => request<PortableWorkbenchConfig>('/api/config/interface-mode', { method: 'POST', body: JSON.stringify({ interface_mode: interfaceMode }) }),
  firstRun: () => request<FirstRunStatus>('/api/first-run'),
  firstRunSmoke: () => request<FirstRunSmokeResult>('/api/first-run/smoke', { method: 'POST' }),
  completeFirstRun: (input: Partial<PortableWorkbenchConfig>) => request<{ config: PortableWorkbenchConfig; restart_required: true }>('/api/first-run/complete', { method: 'POST', body: JSON.stringify(input) }),
  distribution: () => request<DistributionStatus>('/api/distribution/status'),
  backups: () => request<BackupManifest[]>('/api/backups'),
  createBackup: () => request<BackupManifest>('/api/backups', { method: 'POST' }),
  verifyBackup: (id: string) => request<BackupManifest>(`/api/backups/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
  profiles: () => request<unknown[]>('/api/profiles'),
  reviewers: () => request<ReviewerProfile[]>('/api/reviewers'),
  createReviewer: (input: { name: string; role: ReviewerRole }) => request<ReviewerProfile>('/api/reviewers', { method: 'POST', body: JSON.stringify(input) }),
  reviewPolicies: () => request<ReviewPolicy[]>('/api/review-policies'),
  workspaces: () => request<{ allowedRoots: string[]; recent: string[] }>('/api/workspaces'),
  projects: (role: 'production' | 'test') => request<{ role: string; projects: Record<string, unknown>[] }>(`/api/projects?role=${role}`),
  projectContexts: () => request<ProjectContextView[]>('/api/projects/context'),
  projectContext: (id: string) => request<ProjectContextView>(`/api/projects/${encodeURIComponent(id)}`),
  registerProject: (input: ProjectRegisterInput) => request<ProjectContextView>('/api/projects/register', { method: 'POST', body: JSON.stringify(input) }),
  scanProject: (id: string) => request<ProjectContextView>(`/api/projects/${encodeURIComponent(id)}/scan`, { method: 'POST' }),
  projectHistory: (id: string) => request<ProjectSnapshotHistoryItem[]>(`/api/projects/${encodeURIComponent(id)}/history`),
  projectTimeline: (id: string) => request<ProjectTimelineEvent[]>(`/api/projects/${encodeURIComponent(id)}/timeline`),
  projectProvenance: (id: string) => request<ProjectProvenanceGraph>(`/api/projects/${encodeURIComponent(id)}/provenance`),
  projectAudit: (id: string) => request<ProjectEvidenceAuditReport>(`/api/projects/${encodeURIComponent(id)}/audit`),
  projectEvidenceHealth: (id: string) => request<ProjectEvidenceHealth>(`/api/projects/${encodeURIComponent(id)}/evidence-health`),
  projectReviews: (id: string) => request<ProjectReviewQueue>(`/api/projects/${encodeURIComponent(id)}/reviews`),
  projectReviewSummary: (id: string) => request<ProjectReviewSummary>(`/api/projects/${encodeURIComponent(id)}/review-summary`),
  projectReviewHistory: (id: string) => request<ProjectReviewHistory>(`/api/projects/${encodeURIComponent(id)}/review-history`),
  linkProjectMemory: (id: string, memoryProjectId: string, memoryRole: 'production' | 'test') => request<ProjectContextView>(`/api/projects/${encodeURIComponent(id)}/memory-link`, {
    method: 'POST', body: JSON.stringify({ memory_project_id: memoryProjectId, memory_role: memoryRole }),
  }),
  unlinkProjectMemory: (id: string, memoryProjectId: string, memoryRole: 'production' | 'test') => request<ProjectContextView>(`/api/projects/${encodeURIComponent(id)}/memory-link`, {
    method: 'DELETE', body: JSON.stringify({ memory_project_id: memoryProjectId, memory_role: memoryRole }),
  }),
  memoryStatus: (role: 'production' | 'test') => request<Record<string, unknown>>(`/api/memory/status?role=${role}`),
  documentStatus: (role: 'production' | 'test') => request<Record<string, unknown>>(`/api/document-search/status?role=${role}`),
  sessions: () => request<unknown[]>('/api/sessions/recent'),
  legacy: () => request<Record<string, unknown>>('/api/video2skill/reuse-status'),
  videoCapabilities: () => request<VideoCapabilityStatus>('/api/video/capabilities'),
  recheckVideoRuntime: () => request<VideoCapabilityStatus>('/api/video/runtime/recheck', { method: 'POST' }),
  asrDiagnostics: () => request<AsrGpuRuntimeDiagnostics>('/api/video/asr/diagnostics'),
  recheckAsrDiagnostics: () => request<AsrGpuRuntimeDiagnostics>('/api/video/asr/diagnostics/recheck', { method: 'POST' }),
  retrievalDiagnostics: () => request<RetrievalDiagnostics>('/api/retrieval/diagnostics'),
  knowledgeDiagnostics: () => request<KnowledgeExtractionDiagnostics>('/api/knowledge/diagnostics'),
  detectKnowledgeSource: (input: KnowledgeIngestionInput) => request<DetectedKnowledgeSource>('/api/knowledge/detect', { method: 'POST', body: JSON.stringify(input) }),
  ingestKnowledge: (input: KnowledgeIngestionInput) => request<KnowledgeIngestionResult>('/api/knowledge/ingest', { method: 'POST', body: JSON.stringify(input) }),
  knowledgeIngestions: (projectId?: string) => request<KnowledgeIngestionRecord[]>(`/api/knowledge/ingestions${queryString({ project_id: projectId })}`),
  knowledgeIngestion: (id: string) => request<KnowledgeIngestionRecord>(`/api/knowledge/ingestions/${encodeURIComponent(id)}`),
  knowledgeIngestionDocument: (id: string) => request<UnifiedDocumentRecord>(`/api/knowledge/ingestions/${encodeURIComponent(id)}/document`),
  knowledgeAdapterHealth: () => request<KnowledgeSourceAdapterHealth[]>('/api/knowledge/adapters/health'),
  knowledgeBenchmark: () => request<KnowledgeBenchmarkSummary | null>('/api/knowledge/benchmark'),
  learningDocuments: (taskId: string) => request<LearningDocumentRecord[]>(`/api/learning-documents${queryString({ task_id: taskId })}`),
  learningDocument: (id: string) => request<LearningDocumentRecord>(`/api/learning-documents/${encodeURIComponent(id)}`),
  generateLearningDocument: (input: LearningDocumentGenerateInput) => request<LearningDocumentRecord>('/api/learning-documents/generate', { method: 'POST', body: JSON.stringify(input) }),
  resumeLearningDocument: (input: LearningDocumentGenerateInput) => request<LearningDocumentRecord>('/api/learning-documents/resume', { method: 'POST', body: JSON.stringify(input) }),
  regenerateLearningDocument: (id: string, input: Pick<LearningDocumentGenerateInput, 'document_mode' | 'detail_level'> = {}) => request<LearningDocumentRecord>(`/api/learning-documents/${encodeURIComponent(id)}/regenerate`, { method: 'POST', body: JSON.stringify(input) }),
  knowledgeReviewSamples: (limit = 10) => request<Array<{ segment: VideoJobView['segments'][number]; legacy: string; cards: KnowledgeCardRecord[] }>>(`/api/knowledge/review-samples${queryString({ limit })}`),
  extractKnowledge: (documentId: string, segmentIds?: string[]) => request<KnowledgeExtractionResult>(`/api/video/documents/${encodeURIComponent(documentId)}/knowledge/extract`, { method: 'POST', body: JSON.stringify(segmentIds === undefined ? {} : { segment_ids: segmentIds }) }),
  knowledgeCards: (documentId: string) => request<KnowledgeCardRecord[]>(`/api/video/documents/${encodeURIComponent(documentId)}/knowledge/cards`),
  knowledgeCard: (id: string) => request<KnowledgeCardDetail>(`/api/knowledge/cards/${encodeURIComponent(id)}`),
  reviewKnowledgeCard: (id: string, decision: KnowledgeCardReviewDecision, note = '') => request<KnowledgeCardDetail>(`/api/knowledge/cards/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({ decision, note }) }),
  regenerateKnowledgeCard: (id: string) => request<KnowledgeExtractionResult>(`/api/knowledge/cards/${encodeURIComponent(id)}/regenerate`, { method: 'POST' }),
  rebuildRetrievalIndex: (projectId?: string) => request<Record<string, unknown>>('/api/retrieval/index', { method: 'POST', body: JSON.stringify({ project_id: projectId }) }),
  mediaTempPreview: () => request<MediaTempPreview>('/api/media/temp'),
  cleanupMediaTemp: () => request<MediaTempCleanupResult>('/api/media/temp/cleanup', { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  videoJobs: (projectId?: string) => request<VideoJobRecord[]>(`/api/video/jobs${queryString({ project_id: projectId })}`),
  videoJob: (id: string) => request<VideoJobView>(`/api/video/jobs/${encodeURIComponent(id)}`),
  createVideoJob: (input: VideoCreateInput) => request<VideoJobRecord>('/api/video/jobs', { method: 'POST', body: JSON.stringify(input) }),
  startVideoJob: (id: string) => request<VideoJobRecord>(`/api/video/jobs/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  publishVideoJob: (id: string) => request<VideoPublishResult>(`/api/video/jobs/${encodeURIComponent(id)}/publish`, { method: 'POST' }),
  searchVideo: (input: VideoSearchInput) => request<VideoSearchResult[]>('/api/video/search', { method: 'POST', body: JSON.stringify(input) }),
  searchDocument: (input: { query: string; document_id?: string; project_id?: string; top_k?: number }) => request<Array<{ document_id: string; title: string; section: string; source_anchor: string; text: string; score: number }>>('/api/documents/search', { method: 'POST', body: JSON.stringify(input) }),
  askDocument: (input: { query: string; document_id: string; project_id?: string; top_k?: number }) => request<{ answer: string; citations: Array<{ title: string; section: string; source_anchor: string; text: string; score: number }> }>('/api/documents/ask', { method: 'POST', body: JSON.stringify(input) }),
  organizerScan: (input: { input_asset_id: string; mode?: 'light'|'smart'|'project'; optimize_names?: boolean }) => request<Record<string, unknown>>('/api/organizer/scan', { method:'POST',body:JSON.stringify(input) }),
  organizerPlan: (id:string) => request<Record<string, unknown>>(`/api/organizer/plans/${encodeURIComponent(id)}`),
  approveOrganizerPlan: (id:string, operation_ids?:string[]) => request<Record<string, unknown>>(`/api/organizer/plans/${encodeURIComponent(id)}/approve`,{method:'POST',body:JSON.stringify(operation_ids===undefined?{}:{operation_ids})}),
  executeOrganizerPlan: (id:string) => request<Record<string, unknown>>(`/api/organizer/plans/${encodeURIComponent(id)}/execute`,{method:'POST'}),
  organizerHistory: () => request<Record<string, unknown>[]>('/api/organizer/history'),
  organizerRules: () => request<Record<string, unknown>[]>('/api/organizer/rules'),
  createOrganizerRule: (input:{pattern:string;destination_relative_path:string}) => request<Record<string, unknown>>('/api/organizer/rules',{method:'POST',body:JSON.stringify(input)}),
  undoOrganizerPlan: (id:string,inputAssetId:string) => request<Record<string, unknown>>(`/api/organizer/plans/${encodeURIComponent(id)}/undo`,{method:'POST',body:JSON.stringify({input_asset_id:inputAssetId})}),
  editOrganizerOperation: (id:string,operationId:string,destinationRelativePath:string) => request<Record<string, unknown>>(`/api/organizer/plans/${encodeURIComponent(id)}/edit`,{method:'POST',body:JSON.stringify({operation_id:operationId,destination_relative_path:destinationRelativePath})}),
  addOrganizerPending: (id:string,items:Array<{source_relative_path:string;destination_relative_path:string}>) => request<Record<string, unknown>>(`/api/organizer/plans/${encodeURIComponent(id)}/add-pending`,{method:'POST',body:JSON.stringify({items})}),
  documentForTask: (taskId: string) => request<UnifiedDocumentRecord>(`/api/documents/task/${encodeURIComponent(taskId)}`),
  tasks: (options: { limit?: number; include_internal?: boolean; include_hidden?: boolean; status?: string; search?: string } = {}) => request<WorkbenchTask[]>(`/api/tasks${queryString({ limit: options.limit ?? 50, include_internal: options.include_internal ? '1' : undefined, include_hidden: options.include_hidden ? '1' : undefined, status: options.status, search: options.search })}`),
  hideTask: (id: string) => request<WorkbenchTask>(`/api/tasks/${encodeURIComponent(id)}/hide`, { method: 'POST' }),
  restoreTask: (id: string) => request<WorkbenchTask>(`/api/tasks/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  task: (id: string) => request<{ task: WorkbenchTask; events: TaskEvent[]; artifacts: ArtifactRecord[]; artifactCandidates: ArtifactCandidate[]; input: InputAssetView | null }>(`/api/tasks/${encodeURIComponent(id)}`),
  taskRuntime: (id: string) => request<TaskRuntimeView>(`/api/tasks/${encodeURIComponent(id)}/runtime`),
  streamTaskEvents,
  createTask: (input: TaskCreateInput) => request<WorkbenchTask>('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),
  startTask: (id: string) => request<WorkbenchTask>(`/api/tasks/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  cancelTask: (id: string) => request<WorkbenchTask>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  retryTask: (id: string) => request<WorkbenchTask>(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  artifacts: (filters: ArtifactQuery = {}) => request<ArtifactRecord[]>(`/api/artifacts${queryString({
    project_id: filters.project_id,
    task_id: filters.task_id,
    artifact_type: filters.artifact_type,
    status: filters.status,
    limit: filters.limit,
  })}`),
  projectArtifacts: (id: string, type?: ArtifactType, status?: ArtifactStatus) => request<ArtifactRecord[]>(`/api/projects/${encodeURIComponent(id)}/artifacts${queryString({ artifact_type: type, status })}`),
  taskArtifacts: (id: string) => request<ArtifactRecord[]>(`/api/tasks/${encodeURIComponent(id)}/artifacts`),
  registerArtifact: (input: ArtifactRegisterInput) => request<ArtifactRecord>('/api/artifacts/register', { method: 'POST', body: JSON.stringify(input) }),
  deleteArtifact: (id: string) => request<{ artifact: ArtifactRecord; file_deleted: false }>(`/api/artifacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  previewArtifact: (id: string) => request<ArtifactPreview>(`/api/artifacts/${encodeURIComponent(id)}/preview`),
  checkArtifact: (id: string) => request<ArtifactHealthCheck>(`/api/artifacts/${encodeURIComponent(id)}/check`, { method: 'POST' }),
  artifactHistory: (id: string) => request<ArtifactHistory>(`/api/artifacts/${encodeURIComponent(id)}/history`),
  setArtifactStatus: (id: string, status: Extract<ArtifactStatus, 'active' | 'archived'>) => request<ArtifactRecord>(`/api/artifacts/${encodeURIComponent(id)}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  openArtifactLocation: (id: string) => request<{ artifact_id: string; opened: true }>(`/api/artifacts/${encodeURIComponent(id)}/open-location`, { method: 'POST' }),
  openArtifactFile: (id: string) => request<{ artifact_id: string; opened: true }>(`/api/artifacts/${encodeURIComponent(id)}/open-file`, { method: 'POST' }),
  artifactEvidence: (id: string) => request<ArtifactEvidenceBundle>(`/api/artifacts/${encodeURIComponent(id)}/evidence`),
  createArtifactEvidence: (id: string, input: ArtifactEvidenceCreateInput) => request<ArtifactEvidenceView>(`/api/artifacts/${encodeURIComponent(id)}/evidence`, { method: 'POST', body: JSON.stringify(input) }),
  deleteArtifactEvidence: (id: string) => request<{ evidence: ArtifactEvidenceLinkRecord; sources_deleted: false; artifacts_deleted: false }>(`/api/evidence/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  evidenceBySource: (type: ArtifactEvidenceSourceType, id: string) => request<ArtifactEvidenceView[]>(`/api/evidence/source/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  artifactProvenance: (id: string, depth: 1 | 2 | 3 = 1) => request<ArtifactProvenanceGraph>(`/api/artifacts/${encodeURIComponent(id)}/provenance${queryString({ depth })}`),
  auditArtifact: (id: string) => request<ArtifactEvidenceAuditReport>(`/api/artifacts/${encodeURIComponent(id)}/audit`, { method: 'POST' }),
  artifactReviewHistory: (id: string) => request<ArtifactReviewHistory>(`/api/artifacts/${encodeURIComponent(id)}/reviews/history`),
  submitArtifactReview: (id: string, input: { decision: ReviewDecision; reviewer_id: string; policy_type: ReviewPolicyType; note?: string }) => request<ReviewDecisionRecord>(`/api/artifacts/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify(input) }),
  artifactReviewSignature: (id: string) => request<ReviewSignatureEvaluation>(`/api/artifacts/${encodeURIComponent(id)}/review-signature`),
  artifactReviewChange: (id: string) => request<ReviewChangeReport>(`/api/artifacts/${encodeURIComponent(id)}/review-change`),
  artifactReviewTimeline: (id: string) => request<ReviewTimelineEvent[]>(`/api/artifacts/${encodeURIComponent(id)}/review-timeline`),
  recheckArtifactReview: (id: string, input: { decision: ReviewDecision; reviewer_id: string; policy_type: ReviewPolicyType; note?: string }) => request<ReviewRecheckResult>(`/api/artifacts/${encodeURIComponent(id)}/recheck`, { method: 'POST', body: JSON.stringify(input) }),
  artifactProvenanceExport: (id: string) => rawJsonRequest<ArtifactProvenanceManifest>(`/api/artifacts/${encodeURIComponent(id)}/provenance/export`),
  saveTaskAnswerReport: (id: string, input: { auto_link_task?: boolean; auto_link_session?: boolean; evidence?: ArtifactEvidenceCreateInput[] } = {}) => request<TaskReportCandidateResult>(`/api/tasks/${encodeURIComponent(id)}/save-report`, { method: 'POST', body: JSON.stringify(input) }),
  exportTaskAnswerWord: (id: string, input: { auto_link_task?: boolean; auto_link_session?: boolean; evidence?: ArtifactEvidenceCreateInput[] } = {}) => request<TaskWordExportResult>(`/api/tasks/${encodeURIComponent(id)}/export-word`, { method: 'POST', body: JSON.stringify(input) }),
  searchChunks: (payload: Record<string, unknown>) => request<Record<string, unknown>>('/api/document-search/search', { method: 'POST', body: JSON.stringify(payload) }),
  getChunk: (payload: Record<string, unknown>) => request<Record<string, unknown>>('/api/document-search/chunk', { method: 'POST', body: JSON.stringify(payload) }),
}
