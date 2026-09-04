export const TASK_STATUSES = [
  'created',
  'validating',
  'queued',
  'starting',
  'running',
  'completed',
  'failed',
  'canceled',
] as const

export type TaskStatus = typeof TASK_STATUSES[number]
export const TASK_ORIGINS = ['user', 'validation', 'system', 'legacy'] as const
export type TaskOrigin = typeof TASK_ORIGINS[number]

export const TEMPLATE_IDS = [
  'file-analysis',
  'project-summary',
  'memory-query',
  'document-chunk-search',
  'asset-inventory',
  'video-to-knowledge',
  'knowledge-ingestion',
  'file-organizer',
] as const

export type TemplateId = typeof TEMPLATE_IDS[number]
export type DatabaseRole = 'production' | 'test'

export interface PortableWorkbenchConfig {
  config_version: number
  workspace_root: string
  ollama_endpoint: string
  model_name: string
  memory_path: string
  project_path: string
  harness_root: string
  dsh_home: string
  backup_root: string
  ollama_executable: string | null
  ffmpeg_executable: string | null
  ffprobe_executable: string | null
  ytdlp_executable: string | null
  asr_python: string | null
  asr_model_path: string | null
  asr_device: 'auto' | 'cuda' | 'cpu'
  asr_compute_type: string
  asr_gpu_runtime_root: string | null
  asr_gpu_available: boolean
  asr_last_diagnostic_at: string | null
  embedding_provider: 'auto' | 'ollama' | 'local-hash-v1'
  embedding_model: string | null
  embedding_dimension: number
  interface_mode: 'consumer' | 'advanced'
  first_run_completed: boolean
}

export const ARTIFACT_TYPES = [
  'document',
  'report',
  'code',
  'dataset',
  'image',
  'video',
  'audio',
  'log',
  'analysis',
  'other',
] as const

export type ArtifactType = typeof ARTIFACT_TYPES[number]

export const ARTIFACT_STATUSES = [
  'active',
  'missing',
  'outdated',
  'archived',
] as const

export type ArtifactStatus = typeof ARTIFACT_STATUSES[number]

export const ARTIFACT_EVIDENCE_SOURCE_TYPES = [
  'task',
  'session',
  'memory',
  'document_chunk',
  'source',
  'artifact',
] as const

export type ArtifactEvidenceSourceType = typeof ARTIFACT_EVIDENCE_SOURCE_TYPES[number]

export const ARTIFACT_EVIDENCE_RELATION_TYPES = [
  'generated_from',
  'derived_from',
  'references',
  'verified_by',
  'created_by',
] as const

export type ArtifactEvidenceRelationType = typeof ARTIFACT_EVIDENCE_RELATION_TYPES[number]
export type MemoryEntityType = 'project' | 'decision' | 'experiment' | 'document' | 'task' | 'session'

export interface ArtifactEvidenceCreateInput {
  source_type: ArtifactEvidenceSourceType
  source_id: string
  relation_type: ArtifactEvidenceRelationType
  database_role?: DatabaseRole
  memory_type?: MemoryEntityType
}

export interface ArtifactEvidenceLinkRecord {
  id: string
  artifact_id: string
  source_type: ArtifactEvidenceSourceType
  source_id: string
  relation_type: ArtifactEvidenceRelationType
  created_at: string
  metadata: Record<string, unknown>
}

export interface ArtifactEvidenceSourceSummary {
  type: ArtifactEvidenceSourceType
  id: string
  label: string
  available: boolean
  metadata: Record<string, unknown>
}

export interface ArtifactEvidenceView extends ArtifactEvidenceLinkRecord {
  source: ArtifactEvidenceSourceSummary
}

export interface ArtifactEvidenceBundle {
  artifact: ArtifactRecord
  evidence: ArtifactEvidenceView[]
  count: number
}

export type ProvenanceNodeType = ArtifactEvidenceSourceType

export interface ProvenanceGraphNode {
  id: string
  entity_id: string
  type: ProvenanceNodeType
  title: string
  status: string
}

export interface ProvenanceGraphEdge {
  source: string
  target: string
  relation_type: ArtifactEvidenceRelationType
  evidence_id: string
}

export interface ArtifactProvenanceGraph {
  artifact_id: string
  project_id: string
  depth: 1 | 2 | 3
  nodes: ProvenanceGraphNode[]
  edges: ProvenanceGraphEdge[]
  generated_at: string
}

export interface ProjectProvenanceGraph {
  project_id: string
  project_name: string
  artifact_count: number
  nodes: ProvenanceGraphNode[]
  edges: ProvenanceGraphEdge[]
  generated_at: string
}

export type EvidenceAuditStatus = 'healthy' | 'warning' | 'broken'
export type EvidenceAuditIssueSeverity = 'warning' | 'broken'

export interface EvidenceAuditIssue {
  code: string
  severity: EvidenceAuditIssueSeverity
  message: string
  evidence_id?: string
  source_type?: ArtifactEvidenceSourceType
  source_id?: string
}

export interface ArtifactEvidenceAuditReport {
  audit_id: string | null
  artifact_id: string
  project_id: string
  status: EvidenceAuditStatus
  issues: EvidenceAuditIssue[]
  evidence_count: number
  checked_at: string
}

export interface ProjectEvidenceAuditReport {
  project_id: string
  project_name: string
  status: EvidenceAuditStatus
  artifact_count: number
  issue_count: number
  artifacts: ArtifactEvidenceAuditReport[]
  checked_at: string
}

export interface ProvenanceAuditRecord {
  id: string
  artifact_id: string
  status: EvidenceAuditStatus
  issues: EvidenceAuditIssue[]
  created_at: string
}

export type EvidenceHealthIssueSeverity = 'missing' | 'warning' | 'broken'
export const REVIEW_DECISIONS = ['pending', 'approved', 'rejected', 'needs_revision'] as const
export type ReviewDecision = typeof REVIEW_DECISIONS[number]
export const REVIEWER_ROLES = ['reviewer', 'lead_reviewer', 'research_reviewer', 'code_reviewer', 'knowledge_reviewer'] as const
export type ReviewerRole = typeof REVIEWER_ROLES[number]
export const REVIEW_POLICY_TYPES = ['research', 'code', 'knowledge'] as const
export type ReviewPolicyType = typeof REVIEW_POLICY_TYPES[number]
export type ReviewSignatureStatus = 'VALID' | 'INVALID'
export type ReviewInvalidationReason = 'artifact_hash_changed' | 'evidence_hash_changed'
export type ReleaseReadinessStatus = 'READY' | 'NEEDS_REVIEW' | 'NEEDS_RECHECK' | 'REJECTED'

export interface ReviewerProfile {
  id: string
  name: string
  role: ReviewerRole
  created_at: string
  updated_at: string
}

export interface ReviewPolicy {
  id: string
  policy_type: ReviewPolicyType
  version: string
  rules: {
    artifact_types: ArtifactType[]
    reviewer_roles: ReviewerRole[]
    require_evidence: boolean
    require_healthy_audit: boolean
    require_version: boolean
    require_available_sources: boolean
  }
  active: boolean
  created_at: string
  updated_at: string
}

export interface ReviewInvalidation {
  id: string
  review_decision_id: string
  artifact_id: string
  reason: ReviewInvalidationReason
  previous_hash: string
  current_hash: string
  created_at: string
}

export interface ReviewDecisionRecord {
  id: string
  artifact_id: string
  decision: ReviewDecision
  reviewer: string
  reviewer_id: string | null
  artifact_hash: string | null
  evidence_hash: string | null
  policy_type: ReviewPolicyType | null
  policy_version: string | null
  recheck_of_review_id: string | null
  note: string
  created_at: string
}

export type ReviewArtifactSnapshotKind = 'markdown' | 'code' | 'dataset'

export interface ReviewEvidenceSnapshotItem {
  key: string
  evidence_id: string
  source_type: ArtifactEvidenceSourceType
  source_id: string
  relation_type: ArtifactEvidenceRelationType
  available: boolean
  label: string
  metadata: Record<string, unknown>
  source_metadata: Record<string, unknown>
}

export interface ReviewSnapshotDetail {
  review_decision_id: string
  artifact_snapshot_path: string | null
  artifact_snapshot_sha256: string | null
  artifact_snapshot_size: number | null
  artifact_snapshot_kind: ReviewArtifactSnapshotKind | null
  evidence_snapshot: ReviewEvidenceSnapshotItem[]
  created_at: string
}

export interface ArtifactDiffLine {
  kind: 'context' | 'added' | 'removed'
  old_line: number | null
  new_line: number | null
  content: string
}

export interface ArtifactDiffReport {
  artifact_id: string
  artifact_name: string
  supported: boolean
  snapshot_available: boolean
  snapshot_kind: ReviewArtifactSnapshotKind | null
  old_hash: string | null
  new_hash: string
  changed: boolean
  added_lines: number
  removed_lines: number
  changed_blocks: number
  affected_old_range: string | null
  affected_new_range: string | null
  changes: ArtifactDiffLine[]
  truncated: boolean
  impact_scope: 'none' | 'small' | 'medium' | 'large' | 'hash_only'
  note: string
}

export interface EvidenceDiffEntry {
  key: string
  source_type: ArtifactEvidenceSourceType
  source_id: string
  relation_type: ArtifactEvidenceRelationType
  previous: ReviewEvidenceSnapshotItem | null
  current: ReviewEvidenceSnapshotItem | null
}

export interface EvidenceDiffReport {
  snapshot_available: boolean
  old_hash: string | null
  new_hash: string
  changed: boolean
  added: EvidenceDiffEntry[]
  removed: EvidenceDiffEntry[]
  invalidated: EvidenceDiffEntry[]
  restored: EvidenceDiffEntry[]
  metadata_changed: EvidenceDiffEntry[]
  summary_changed: EvidenceDiffEntry[]
  note: string
}

export interface ReviewChangeSnapshot {
  review_decision_id: string | null
  artifact_hash: string | null
  evidence_hash: string | null
  reviewer_id: string | null
  policy_type: ReviewPolicyType | null
  policy_version: string | null
  captured_at: string | null
}

export interface ReviewChangeReport {
  artifact_id: string
  artifact_name: string
  release_status: ReleaseReadinessStatus
  old_snapshot: ReviewChangeSnapshot
  new_snapshot: ReviewChangeSnapshot
  changed_reasons: string[]
  impact: string[]
  artifact_diff: ArtifactDiffReport
  evidence_diff: EvidenceDiffReport
  generated_at: string
}

export type ReviewTimelineEventType = 'initial_review' | 'review_submitted' | 'change_detected' | 'review_rechecked'

export interface ReviewTimelineEvent {
  id: string
  artifact_id: string
  type: ReviewTimelineEventType
  title: string
  timestamp: string
  review_decision_id: string | null
  decision: ReviewDecision | null
  reason: ReviewInvalidationReason | null
  reviewer: string | null
  details: Record<string, unknown>
}

export interface ReviewRecheckResult {
  review: ReviewDecisionRecord
  previous_review_id: string
  accepted_version: ArtifactVersionRecord | null
  change_report: ReviewChangeReport
  release: ArtifactReleaseAuditReport
  timeline: ReviewTimelineEvent[]
}

export interface ProjectReviewHistoryItem {
  artifact: ArtifactRecord
  change_report: ReviewChangeReport
  timeline: ReviewTimelineEvent[]
  review_count: number
}

export interface ProjectReviewHistory {
  project_id: string
  project_name: string
  initial_review_count: number
  change_event_count: number
  recheck_count: number
  artifacts: ProjectReviewHistoryItem[]
  generated_at: string
}

export interface ReviewSignatureEvaluation {
  artifact_id: string
  review_decision_id: string | null
  status: ReviewSignatureStatus
  needs_recheck: boolean
  reasons: string[]
  artifact_hash: string
  evidence_hash: string
  policy_type: ReviewPolicyType | null
  policy_version: string | null
  reviewer: ReviewerProfile | null
  policy: ReviewPolicy | null
  policy_passed: boolean
  invalidations: ReviewInvalidation[]
  checked_at: string
}

export interface ArtifactReviewHistory {
  artifact: ArtifactRecord
  current_decision: ReviewDecision
  history: ReviewDecisionRecord[]
  current_signature: ReviewSignatureEvaluation
  invalidations: ReviewInvalidation[]
  timeline?: ReviewTimelineEvent[]
  count: number
}

export type ReviewQueueSeverity = 'missing' | 'warning' | 'broken' | 'needs_review' | 'needs_recheck'
export type ReviewEvidenceStatus = 'available' | 'missing' | 'broken'

export interface ReviewQueueItem {
  artifact_id: string
  artifact_name: string
  artifact_type: ArtifactType
  artifact_status: ArtifactStatus
  issue: string
  issues: EvidenceAuditIssue[]
  severity: ReviewQueueSeverity
  evidence_status: ReviewEvidenceStatus
  audit_status: EvidenceAuditStatus
  release_status: ReleaseReadinessStatus
  current_decision: ReviewDecision
  signature_status: ReviewSignatureStatus
  reviewer: ReviewerProfile | null
  policy_type: ReviewPolicyType | null
  policy_version: string | null
  invalidation_count: number
  updated_at: string
}

export interface ProjectReviewQueue {
  project_id: string
  project_name: string
  count: number
  reviews: ReviewQueueItem[]
  generated_at: string
}

export interface ProjectReviewSummary {
  project_id: string
  project_name: string
  artifact_count: number
  pending: number
  approved: number
  needs_revision: number
  rejected: number
  needs_recheck: number
  queue_count: number
  reviewers: ReviewerProfile[]
  active_policies: ReviewPolicy[]
  generated_at: string
}

export interface ArtifactReleaseAuditCheck {
  id: 'evidence_present' | 'audit_healthy' | 'version_present' | 'source_available' | 'review_approved' | 'policy_pass' | 'signature_valid'
  passed: boolean
  message: string
}

export interface ArtifactReleaseAuditReport {
  artifact_id: string
  project_id: string
  status: ReleaseReadinessStatus
  review_decision: ReviewDecision
  signature_status: ReviewSignatureStatus
  policy_type: ReviewPolicyType | null
  policy_version: string | null
  invalidations: ReviewInvalidation[]
  checks: ArtifactReleaseAuditCheck[]
  checked_at: string
}

export interface ProjectEvidenceHealthIssue {
  artifact_id: string
  artifact_name: string
  severity: EvidenceHealthIssueSeverity
  code: string
  issue: string
  created_at: string
}

export interface ProjectEvidenceRecentAudit extends ProvenanceAuditRecord {
  artifact_name: string
  artifact_type: ArtifactType
}

export interface ProjectEvidenceHealth {
  project_id: string
  project_name: string
  artifact_count: number
  covered_count: number
  coverage: number
  health_summary: {
    healthy: number
    warning: number
    broken: number
  }
  issue_count: number
  issues: ProjectEvidenceHealthIssue[]
  recent_audits: ProjectEvidenceRecentAudit[]
  release_summary: {
    ready: number
    needs_review: number
    needs_recheck: number
    rejected: number
  }
  release_readiness: ArtifactReleaseAuditReport[]
  checked_at: string
}

export interface ArtifactProvenanceManifest {
  manifest_version: '1'
  artifact: {
    id: string
    project_id: string
    task_id: string | null
    artifact_type: ArtifactType
    status: ArtifactStatus
  }
  hash: string
  relations: Array<{
    evidence_id: string
    source_type: ArtifactEvidenceSourceType
    source_id: string
    relation_type: ArtifactEvidenceRelationType
  }>
  created_at: string
}

export interface ArtifactRecord {
  id: string
  project_id: string
  task_id: string | null
  artifact_type: ArtifactType
  name: string
  relative_path: string
  absolute_path: string
  mime_type: string
  size_bytes: number
  sha256: string
  status: ArtifactStatus
  version_count: number
  created_at: string
  metadata: Record<string, unknown>
}

export interface ArtifactRegisterInput {
  project_id: string
  task_id?: string
  file_path: string
  artifact_type?: ArtifactType
  name?: string
  metadata?: Record<string, unknown>
  supersedes_artifact_id?: string
  change_note?: string
  auto_link_task?: boolean
  auto_link_session?: boolean
  evidence?: ArtifactEvidenceCreateInput[]
}

export interface ArtifactQuery {
  project_id?: string
  task_id?: string
  artifact_type?: ArtifactType
  status?: ArtifactStatus
  limit?: number
}

export interface ArtifactVersionRecord {
  id: string
  artifact_id: string
  version_number: number
  sha256: string
  size_bytes: number
  created_at: string
  change_note: string
}

export interface ArtifactVersionLinkRecord {
  id: string
  old_artifact_id: string
  new_artifact_id: string
  relation: 'supersedes'
  created_at: string
}

export interface ArtifactHistory {
  current_artifact_id: string
  version_count: number
  artifacts: ArtifactRecord[]
  versions: ArtifactVersionRecord[]
  links: ArtifactVersionLinkRecord[]
}

export interface ArtifactPreview {
  artifact: ArtifactRecord
  preview_type: 'text' | 'code' | 'image'
  content: string | null
  truncated: boolean
  width: number | null
  height: number | null
  mime: string
}

export interface ArtifactHealthCheck {
  artifact_id: string
  previous_hash: string
  current_hash: string | null
  previous_status: ArtifactStatus
  status: ArtifactStatus
  observed_status: Exclude<ArtifactStatus, 'archived'>
  checked_at: string
}

export interface TaskReportCandidateResult {
  candidate: ArtifactCandidate
  file_created: true
  artifact_registered: true
  artifact: ArtifactRecord
  evidence_count: number
}

/** Word 文件由同一份受控 Markdown 报告导出，保留原报告与其 Evidence。 */
export interface TaskWordExportResult {
  markdown_artifact: ArtifactRecord
  word_artifact: ArtifactRecord
  word_path: string
  evidence_count: number
}

export interface ArtifactCandidate {
  project_id: string
  task_id: string
  artifact_type: ArtifactType
  name: string
  relative_path: string
  absolute_path: string
  mime_type: string
  size_bytes: number
  modified_at: string
  registered_artifact_id: string | null
}

export const PROJECT_TYPES = [
  'personal',
  'node',
  'python',
  'mixed',
  'research',
  'software',
  'documentation',
  'general',
] as const

export type ProjectType = typeof PROJECT_TYPES[number]

export const INPUT_TYPES = ['file', 'directory', 'url', 'text'] as const
export type InputAssetType = typeof INPUT_TYPES[number]
export const INPUT_SOURCE_MODES = ['native_picker', 'drag_drop', 'manual_path', 'url', 'project'] as const
export type InputSourceMode = typeof INPUT_SOURCE_MODES[number]
export const INPUT_ACCESS_MODES = ['project', 'temporary_grant', 'staged_copy'] as const
export type InputAccessMode = typeof INPUT_ACCESS_MODES[number]
export type InputGrantScope = 'exact_file' | 'directory_tree'
export type InputGrantStatus = 'selected' | 'granted' | 'attached_to_task' | 'expired'

export interface InputAsset {
  id: string
  input_type: InputAssetType
  display_name: string
  original_path: string | null
  staged_path: string | null
  access_mode: InputAccessMode
  source_mode: InputSourceMode
  mime_type: string
  size_bytes: number | null
  sha256: string | null
  created_at: string
  expires_at: string | null
  task_id: string | null
  project_id: string | null
  metadata: Record<string, unknown>
}

export interface TemporaryInputGrant {
  grant_id: string
  input_asset_id: string
  selected_path: string
  kind: 'file' | 'directory'
  scope: InputGrantScope
  created_at: string
  expires_at: string
  task_id: string | null
  status: InputGrantStatus
  source_mode: 'native_picker'
}

export interface InputAssetView {
  asset: InputAsset
  grant: TemporaryInputGrant | null
  effective_path: string | null
  capability: InputCapability
}

export interface InputCapability {
  extensions: string[]
  category: 'text/code' | 'directory' | 'pdf' | 'office' | 'image' | 'subtitle' | 'video' | 'audio' | 'unknown'
  mode: 'native_read' | 'current_parser' | 'structured_parser' | 'metadata_only' | 'pending_parser' | 'registered_only'
  label: string
  analyzable: boolean
}

export interface NativeInputSelection {
  canceled: boolean
  path: string | null
  kind: 'file' | 'directory'
  asset: InputAssetView | null
}

export interface WorkbenchTask {
  id: string
  projectId: string | null
  templateId: TemplateId
  title: string
  inputType: string
  inputValue: string
  workspacePath: string | null
  projectName: string | null
  profile: string
  permissionMode: 'read-only'
  status: TaskStatus
  taskOrigin: TaskOrigin
  hiddenAt: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  harnessSessionId: string | null
  runtimePid: number | null
  resultText: string | null
  errorCode: string | null
  errorMessage: string | null
  artifactIndex: unknown[]
  citationIndex: string[]
  metadata: Record<string, unknown>
}

export const KNOWLEDGE_SOURCE_TYPES = [
  'local_file',
  'local_folder',
  'video_url',
  'web_url',
  'github_repo',
  'text_input',
] as const

export type KnowledgeSourceType = typeof KNOWLEDGE_SOURCE_TYPES[number]
export type KnowledgeIngestionPipeline = 'video_knowledge' | 'file_analysis' | 'folder_inventory' | 'web_knowledge' | 'github_knowledge' | 'document_knowledge' | 'source_registration'

/** 来源记录只包含位置、类型和受控元数据，文本正文仍由既有 Task 输入字段管理。 */
export interface DetectedKnowledgeSource {
  source_type: KnowledgeSourceType
  source_reference: string
  display_name: string
  metadata: Record<string, unknown>
}

export interface KnowledgeIngestionInput {
  input_value?: string
  input_asset_id?: string
  project_id?: string
  title?: string
  /** 高级模式可显式改写自动识别结果；服务端仍会执行对应安全校验。 */
  source_type_override?: KnowledgeSourceType
  /** 学习资料组织模式；未指定时由来源适配器给出推荐值。 */
  document_mode?: LearningDocumentMode
}

export interface KnowledgeIngestionRecord extends DetectedKnowledgeSource {
  id: string
  task_id: string
  project_id: string | null
  pipeline: KnowledgeIngestionPipeline
  created_at: string
}

export interface KnowledgeIngestionResult {
  source: DetectedKnowledgeSource
  ingestion: KnowledgeIngestionRecord
  task: WorkbenchTask
  video_job: VideoJobRecord | null
  message: string
}

/** 公开网页和公开仓库在本机清洗后的统一内容载体。 */
export interface UnifiedDocumentSection {
  heading: string
  level: number
  text: string
  source_anchor: string
}

export interface UnifiedDocumentCodeBlock {
  language: string | null
  content: string
  source_anchor: string
}

export interface UnifiedDocumentRecord {
  id: string
  task_id: string
  project_id: string
  /** Existing web/GitHub records remain unchanged; local documents use local_file plus document_subtype metadata. */
  source_type: Extract<KnowledgeSourceType, 'web_url' | 'github_repo' | 'local_file'>
  source_url: string
  canonical_url: string
  title: string
  author: string | null
  site_name: string | null
  description: string | null
  language: string | null
  content_type: string
  content: string
  sections: UnifiedDocumentSection[]
  code_blocks: UnifiedDocumentCodeBlock[]
  links: string[]
  metadata: Record<string, unknown>
  acquired_at: string
  content_sha256: string
}

export interface KnowledgeSourceAdapterHealth {
  id: 'video' | 'web' | 'github' | 'document'
  available: boolean
  detail: string
}

export interface TaskEvent {
  id: number
  taskId: string
  eventType: string
  source: 'workbench' | 'harness'
  payload: unknown
  createdAt: string
}

/** 用户可见的统一任务运行阶段。 */
export type TaskRuntimeStage =
  | 'created'
  | 'initializing'
  | 'detecting_source'
  | 'adapting'
  | 'fetching'
  | 'processing'
  | 'transcribing'
  | 'segmenting'
  | 'embedding'
  | 'extracting'
  | 'generating'
  | 'learning_document_planning'
  | 'learning_document_generating'
  | 'docx_rendering'
  | 'output_ready'
  | 'scanning_files'
  | 'analyzing_files'
  | 'planning_organization'
  | 'awaiting_confirmation'
  | 'creating_directories'
  | 'moving_files'
  | 'review'
  | 'completed'
  | 'failed'

export type TaskRuntimeStatus = 'created' | 'running' | 'completed' | 'failed' | 'canceled'

/** 当前状态单独持久化，详细历史继续保存在 task_events。 */
export interface TaskRuntimeState {
  task_id: string
  task_type: string
  current_stage: TaskRuntimeStage
  progress: number
  status: TaskRuntimeStatus
  message: string
  started_at: string | null
  finished_at: string | null
  active_model: string | null
  updated_at: string
}

export interface TaskRuntimeLogEntry {
  timestamp: string
  stage: TaskRuntimeStage
  level: 'info' | 'warning' | 'error'
  message: string
}

export interface TaskRuntimeView {
  runtime: TaskRuntimeState
  completed_stages: TaskRuntimeStage[]
  logs: TaskRuntimeLogEntry[]
  active_tool: string | null
}

/** 面向普通用户的学习资料组织模型；内容只来自当前任务已经取得的资料。 */
export type LearningDocumentMode = 'learning_notes' | 'review_notes' | 'technical_guide' | 'simple_summary'
export type LearningDocumentDetailLevel = 'concise' | 'standard' | 'detailed'

export interface LearningDocumentSection {
  title: string
  summary: string
  body: string
  key_points: string[]
  examples: string[]
  source_refs: string[]
}

export interface LearningTerm {
  term: string
  explanation: string
}

export interface LearningDocumentReference {
  label: string
  reference: string
  time_range?: string
}

export interface LearningDocumentRecord {
  id: string
  task_id: string
  project_id: string
  source_type: string
  source_title: string
  source_reference: string
  document_title: string
  document_mode: LearningDocumentMode
  detail_level: LearningDocumentDetailLevel
  summary: string
  sections: LearningDocumentSection[]
  learning_goals: string[]
  key_points: string[]
  terms: LearningTerm[]
  formulas: string[]
  code_examples: string[]
  confusions: string[]
  review_questions: string[]
  learning_tips: string[]
  references: LearningDocumentReference[]
  json_artifact_id: string | null
  docx_artifact_id: string | null
  supersedes_document_id: string | null
  created_at: string
}

export interface LearningDocumentGenerateInput {
  task_id: string
  document_mode?: LearningDocumentMode
  detail_level?: LearningDocumentDetailLevel
  supersedes_document_id?: string
}

export interface RuntimeMonitor {
  captured_at: string
  gpu: {
    available: boolean
    name: string | null
    utilization_percent: number | null
    memory_used_mb: number | null
    memory_total_mb: number | null
  }
  cpu: { logical_cores: number; load_average_1m: number | null; process_rss_mb: number }
  memory: { total_mb: number; used_mb: number; free_mb: number }
  active_model: string | null
  current_task: Pick<TaskRuntimeState, 'task_id' | 'task_type' | 'current_stage' | 'progress' | 'status' | 'message'> | null
}

export interface TaskCreateInput {
  templateId: TemplateId
  title?: string
  inputType?: string
  inputValue: string
  workspacePath?: string
  projectName?: string
  databaseRole?: DatabaseRole
  inputAssetId?: string
  taskOrigin?: Exclude<TaskOrigin, 'legacy'>
}

export interface ProjectDetection {
  hasSrc: boolean
  hasDocs: boolean
  hasReadme: boolean
  hasPackageJson: boolean
  hasPyprojectToml: boolean
  hasPdf: boolean
}

export interface ProjectAssetSnapshot {
  id: string
  projectId: string
  canonicalRoot: string
  fileCount: number
  directoryCount: number
  totalBytes: number
  extensionDistribution: { extension: string; count: number }[]
  recentFiles: { path: string; size: number; modifiedAt: string }[]
  largeFiles: { path: string; size: number }[]
  skippedCount: number
  durationMs: number
  detectedSignals: ProjectDetection
  createdAt: string
}

export interface ProjectMemoryReference {
  id: string
  projectId: string
  memoryRole: DatabaseRole
  memoryProjectName: string
  memoryEntityType: string
  memoryEntityId: string
  createdAt: string
}

export interface ProjectSnapshotHistoryItem {
  snapshot_id: string
  scan_time: string
  file_count: number
  directory_count: number
  total_bytes: number
  extension_summary: { extension: string; count: number }[]
}

export interface ProjectChangeSummary {
  latest_snapshot_id: string
  previous_snapshot_id: string
  latest_scan_time: string
  previous_scan_time: string
  added_files_estimate: number
  file_count_change: number
  size_change: number
  file_change_ratio: number
  new_extensions: string[]
  removed_extensions: string[]
}

export type ProjectTimelineEventType =
  | 'project_created'
  | 'scan_completed'
  | 'task_completed'
  | 'memory_linked'
  | 'artifact_created'
  | 'artifact_version_created'
  | 'artifact_status_changed'
  | 'evidence_linked'
  | 'audit_completed'

export interface ProjectTimelineEvent {
  timestamp: string
  type: ProjectTimelineEventType
  title: string
  source: string
  artifact_id?: string
  name?: string
  artifact_type?: ArtifactType
  artifact_status?: ArtifactStatus
  version_number?: number
  evidence_id?: string
  evidence_source_type?: ArtifactEvidenceSourceType
  evidence_relation_type?: ArtifactEvidenceRelationType
  audit_id?: string
  audit_status?: EvidenceAuditStatus
  audit_issue_count?: number
}

export type ProjectActionType = 'create_task' | 'rescan_project' | 'generate_report'

export interface ProjectRecommendedAction {
  action_type: ProjectActionType
  label: string
  payload: Record<string, unknown>
}

export interface ProjectContext {
  id: string
  name: string
  rootPath: string
  description: string
  projectType: ProjectType
  createdAt: string
  updatedAt: string
  lastScanAt: string | null
}

export interface ProjectContextView extends ProjectContext {
  assetStats: ProjectAssetSnapshot | null
  recentTasks: WorkbenchTask[]
  taskCount: number
  memoryReferenceCount: number
  memoryReferences: ProjectMemoryReference[]
  changeSummary: ProjectChangeSummary | null
  actions: ProjectRecommendedAction[]
  /** STEP-16 compatibility labels. New clients should use actions. */
  recommendedActions: string[]
}

export interface ProjectRegisterInput {
  rootPath: string
  name?: string
  description?: string
  inputAssetId?: string
}

export interface TaskTemplate {
  id: TemplateId
  label: string
  description: string
  enabled: boolean
  execution: 'harness' | 'deterministic' | 'planned' | 'video'
  profile: string | null
  capabilities: string[]
}

export type VideoInputType = 'url' | 'local_video' | 'subtitle' | 'audio'
export type VideoJobStatus =
  | 'created'
  | 'inspecting'
  | 'acquiring'
  | 'transcribing'
  | 'segmenting'
  | 'embedding'
  | 'packaging'
  | 'awaiting_review'
  | 'approved'
  | 'published'
  | 'failed'
  | 'canceled'

export type VideoMemoryState = 'staged' | 'approved' | 'published'

export interface VideoCapabilityStatus {
  downloader: { available: boolean; executable: string | null; version?: string | null; reason: string | null }
  ffmpeg: { available: boolean; executable: string | null; version?: string | null; reason: string | null }
  ffprobe: { available: boolean; executable: string | null; version?: string | null; reason: string | null }
  ocr: { available: boolean; python: string | null; engine: string | null; reason: string | null }
  asr: {
    available: boolean
    python: string | null
    model_path: string | null
    device: 'auto' | 'cuda' | 'cpu'
    compute_type: string
    resolved_device?: 'cuda' | 'cpu'
    gpu_runtime_available?: boolean
    gpu_runtime_root?: string | null
    runtime_status?: 'available' | 'fallback' | 'error'
    reason: string | null
  }
  embedding: { available: true; provider: 'ollama' | 'local-hash-v1'; model: string; dimensions: number; diagnostic: string }
  accepted_inputs: VideoInputType[]
}

export interface AsrGpuDllStatus {
  name: string
  path: string
  exists: boolean
  size_bytes: number | null
  sha256: string | null
}

export interface AsrBenchmarkSample {
  sample_id: string
  media_path: string
  media_duration_seconds: number
  device: 'cuda' | 'cpu'
  compute_type: string
  asr_time_seconds: number
  rtf: number
  peak_vram_mb: number | null
  transcript_sha256: string
  transcript_text: string
  language: string
}

export interface AsrBenchmarkComparison {
  sample_id: string
  cpu: AsrBenchmarkSample
  gpu: AsrBenchmarkSample
  speedup: number
  exact_match: boolean
  normalized_match: boolean
  character_difference_ratio: number
}

export interface AsrBenchmarkReport {
  generated_at: string
  selected_compute_type: string
  comparisons: AsrBenchmarkComparison[]
  summary: {
    sample_count: number
    mean_speedup: number
    mean_cpu_rtf: number
    mean_gpu_rtf: number
    peak_vram_mb: number | null
  }
}

export interface AsrGpuRuntimeDiagnostics {
  status: 'available' | 'unavailable' | 'error'
  checked_at: string
  gpu_name: string | null
  driver_version: string | null
  cuda_driver_version: string | null
  gpu_memory_total_mb: number | null
  gpu_runtime_root: string | null
  runtime_versions: {
    cuda_runtime: string | null
    cublas: string | null
    cudnn: string | null
  }
  dlls: AsrGpuDllStatus[]
  python: string | null
  model_path: string | null
  requested_device: 'auto' | 'cuda' | 'cpu'
  selected_device: 'cuda' | 'cpu'
  selected_compute_type: string
  fallback_reason: string | null
  fallback_validation: {
    tested_at: string
    requested_device: 'auto'
    resolved_device: 'cpu'
    compute_type: 'int8'
    fallback_used: true
    reason: string
    duration_ms: number
  } | null
  benchmark: AsrBenchmarkReport | null
  process_path_unchanged: boolean
}

export type TranscriptSource = 'user_subtitle' | 'sidecar_subtitle' | 'embedded_subtitle' | 'local_asr'

export interface MediaProbeResult {
  format: string | null
  duration_seconds: number
  size_bytes: number | null
  video_codec: string | null
  audio_codec: string | null
  width: number | null
  height: number | null
  fps: number | null
  audio_streams: number
  subtitle_streams: number
}

export interface VideoProcessLogEntry {
  timestamp: string
  stage: string
  level: 'info' | 'warning' | 'error'
  message: string
  duration_ms?: number
}

export interface VideoJobRecord {
  id: string
  project_id: string
  task_id: string | null
  input_type: VideoInputType
  input_value: string
  title: string
  language: string
  status: VideoJobStatus
  stage: string
  progress: number
  source_path: string | null
  subtitle_path: string | null
  video_document_id: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  metadata: Record<string, unknown>
}

export interface VideoDocumentRecord {
  id: string
  project_id: string
  video_job_id: string
  source_artifact_id: string | null
  transcript_artifact_id: string | null
  knowledge_artifact_id: string | null
  title: string
  source_kind: VideoInputType
  source_reference: string
  language: string
  duration_ms: number
  segment_count: number
  knowledge_point_count: number
  memory_state: VideoMemoryState
  memory_project_name: string | null
  published_at: string | null
  created_at: string
  updated_at: string
  metadata: Record<string, unknown>
}

export interface VideoSegmentRecord {
  id: string
  video_document_id: string
  segment_index: number
  start_ms: number
  end_ms: number
  text: string
  text_hash: string
  embedding_provider: string
  embedding_model: string
  embedding_dimensions: number
  embedding: number[]
  created_at: string
  citation: string
}

export interface VideoKnowledgePointRecord {
  id: string
  video_document_id: string
  segment_id: string
  title: string
  summary: string
  keywords: string[]
  confidence: number
  memory_state: VideoMemoryState
  created_at: string
  citation: string
}

export type KnowledgeCardStatus = 'staged' | 'approved' | 'rejected' | 'superseded'
export type KnowledgeCardValidationStatus = 'valid' | 'needs_grounding_review'
export type KnowledgeCardDuplicateStatus = 'unique' | 'possible_duplicate' | 'same_source_duplicate'
export type KnowledgeCardReviewDecision = 'approved' | 'needs_revision' | 'rejected'
export type KnowledgeCardRelationType = 'causes' | 'contrasts_with' | 'part_of' | 'requires' | 'explains' | 'related_to'

export interface KnowledgeCardRelation {
  type: KnowledgeCardRelationType
  target: string
}

export interface KnowledgeCardRecord {
  id: string
  batch_id: string
  video_document_id: string
  segment_id: string
  card_index: number
  title: string
  concept: string
  core_claim: string
  explanation: string
  keywords: string[]
  relations: KnowledgeCardRelation[]
  source_segment_ids: string[]
  source_start: number
  source_end: number
  extractor_provider: 'qwen3_local'
  extractor_model: string
  prompt_version: string
  source_sha256: string
  card_sha256: string
  embedding_input_version: string
  status: KnowledgeCardStatus
  validation_status: KnowledgeCardValidationStatus
  grounding_issues: string[]
  duplicate_status: KnowledgeCardDuplicateStatus
  duplicate_of_card_id: string | null
  source_state: 'current' | 'outdated'
  artifact_id: string | null
  supersedes_card_id: string | null
  created_at: string
  citation: string
}

export interface KnowledgeCardBatchRecord {
  id: string
  video_document_id: string
  task_id: string | null
  artifact_id: string | null
  extractor_provider: 'qwen3_local'
  extractor_model: string
  prompt_version: string
  status: 'staged' | 'approved' | 'rejected'
  card_count: number
  started_at: string
  completed_at: string | null
  metrics: Record<string, unknown>
}

export interface KnowledgeCardReviewRecord {
  id: string
  card_id: string
  decision: KnowledgeCardReviewDecision
  note: string
  created_at: string
}

export interface KnowledgeCardDetail {
  card: KnowledgeCardRecord
  segment: VideoSegmentRecord
  document: VideoDocumentRecord
  artifact: ArtifactRecord | null
  evidence: ArtifactEvidenceView[]
  reviews: KnowledgeCardReviewRecord[]
}

export interface KnowledgeExtractionMetrics {
  segment_count: number
  card_count: number
  valid_card_count: number
  source_link_count: number
  grounding_pass_count: number
  possible_duplicate_count: number
  same_source_duplicate_count: number
  repair_count: number
  total_duration_ms: number
  average_segment_latency_ms: number
  p50_segment_latency_ms: number
  p95_segment_latency_ms: number
  prompt_tokens: number
  output_tokens: number
  sampled_peak_vram_mb: number | null
}

export interface KnowledgeExtractionResult {
  batch: KnowledgeCardBatchRecord
  cards: KnowledgeCardRecord[]
  artifact: ArtifactRecord
  metrics: KnowledgeExtractionMetrics
}

export interface KnowledgeExtractionDiagnostics {
  status: 'available' | 'unavailable'
  provider: 'qwen3_local'
  model: string
  endpoint: string
  prompt_version: string
  structured_output: 'json_schema'
  thinking: false
  temperature: number
  top_p: number
  context_length: number
  maximum_cards_per_segment: number
  card_count: number
  staged: number
  approved: number
  rejected: number
  needs_grounding_review: number
  possible_duplicates: number
  same_source_duplicates: number
  latest_benchmark: KnowledgeBenchmarkSummary | null
}

export interface KnowledgeBenchmarkSummary {
  created_at: string
  corpus_size: number
  schema_valid_rate: number
  source_link_rate: number
  numeric_grounding_pass_rate: number
  keyword_coverage: number
  legacy_average_characters: number
  structured_average_characters: number
  compression_ratio: number
  cards_per_segment: number
  legacy_duplicate_rate: number
  structured_duplicate_rate: number
  legacy_retrieval: RetrievalBenchmarkMetrics
  structured_retrieval: RetrievalBenchmarkMetrics
  selected_default: 'legacy' | 'structured'
  extractor_model: string
  embedding_model: string
  total_extraction_ms: number
  p50_extraction_ms: number
  p95_extraction_ms: number
}

export interface VideoKnowledgeEdgeRecord {
  id: string
  video_document_id: string
  source_knowledge_point_id: string
  target_knowledge_point_id: string
  relation: 'precedes' | 'related_to' | 'supports'
  created_at: string
}

export interface VideoChapter {
  index: number
  title: string
  start_ms: number
  end_ms: number
  segment_ids: string[]
}

export interface VideoJobView {
  job: VideoJobRecord
  document: VideoDocumentRecord | null
  segments: VideoSegmentRecord[]
  knowledge_points: VideoKnowledgePointRecord[]
  knowledge_cards: KnowledgeCardRecord[]
  knowledge_card_batches: KnowledgeCardBatchRecord[]
  edges: VideoKnowledgeEdgeRecord[]
  chapters: VideoChapter[]
  artifacts: ArtifactRecord[]
  reviews: ReviewDecisionRecord[]
  logs: VideoProcessLogEntry[]
}

export interface VideoCreateInput {
  project_id?: string
  input_type: VideoInputType
  input_value: string
  input_asset_id?: string
  title?: string
  language?: string
}

export interface VideoSearchResult {
  video_document_id: string
  segment_id: string
  knowledge_point_id: string | null
  knowledge_card_id: string | null
  entity_type: 'video_segment' | 'knowledge_point' | 'knowledge_card'
  entity_id: string
  provider: 'ollama' | 'local-hash-v1'
  model: string
  dimension: number
  title: string
  start_ms: number
  end_ms: number
  text: string
  score: number
  citation: string
  video_citation: string
  segment_citation: string
  knowledge_citation: string | null
  card_citation: string | null
  structured_card: Pick<KnowledgeCardRecord, 'title' | 'concept' | 'core_claim' | 'explanation' | 'keywords' | 'status' | 'validation_status' | 'duplicate_status'> | null
  artifact_id: string | null
  artifact_name: string | null
  evidence_count: number
  evidence_summary: Array<{ source_type: string; source_id: string; relation_type: string }>
  transcript_source: string
  memory_state: VideoMemoryState
  index_state: 'staged' | 'approved'
  fallback_used: boolean
  fallback_reason: string | null
}

export interface VideoSearchInput {
  query: string
  project_id?: string
  provider?: 'semantic' | 'local-hash-v1'
  top_k?: number
  entity_type?: 'video_segment' | 'knowledge_point' | 'knowledge_card' | 'all'
}

export interface EmbeddingRecord {
  id: string
  entity_type: 'video_segment' | 'knowledge_point' | 'knowledge_card'
  entity_id: string
  provider: 'ollama' | 'local-hash-v1'
  model: string
  dimension: number
  content_sha256: string
  vector_bytes: number
  created_at: string
  is_active: boolean
  index_state: 'staged' | 'approved'
}

export interface RetrievalDiagnostics {
  status: 'semantic' | 'fallback'
  provider: 'ollama' | 'local-hash-v1'
  model: string
  dimension: number
  runtime: 'ollama' | 'node'
  indexed_entities: { total: number; video_segments: number; knowledge_points: number; knowledge_cards: number; staged: number; approved: number }
  stale_embeddings: number
  average_latency_ms: number | null
  fallback_available: true
  fallback_model: 'unicode-ngram-sha256'
  formal_provider_available: boolean
  formal_provider_diagnostic: string
  default_mode: 'semantic' | 'local-hash-v1'
  benchmark: RetrievalBenchmarkSummary | null
}

export interface RetrievalBenchmarkMetrics {
  recall_at_1: number
  recall_at_3: number
  recall_at_5: number
  mrr_at_5: number
  ndcg_at_5: number
  citation_hit_rate_at_5: number
  timestamp_citation_rate_at_5: number
  average_query_latency_ms: number
  p50_query_latency_ms: number
  p95_query_latency_ms: number
}

export interface RetrievalBenchmarkSummary {
  created_at: string
  corpus_size: number
  query_count: number
  chinese_query_count: number
  selected_default: 'semantic' | 'local-hash-v1'
  semantic_model: string
  baseline: RetrievalBenchmarkMetrics
  semantic: RetrievalBenchmarkMetrics
  chinese_baseline: RetrievalBenchmarkMetrics
  chinese_semantic: RetrievalBenchmarkMetrics
  semantic_index_build_ms: number
  semantic_embedding_texts_per_second: number
  semantic_vector_storage_bytes: number
  model_load_ms: number
  peak_vram_mb: number | null
}

export interface MediaTempPreview {
  root: string
  files: Array<{ relative_path: string; size_bytes: number }>
  total_bytes: number
}

export interface MediaTempCleanupResult {
  removed: string[]
  retained: string[]
  total_bytes: number
}

export interface VideoPublishResult {
  video_document: VideoDocumentRecord
  artifact_id: string
  release_status: string
  memory_state: VideoMemoryState
  published_knowledge_points: number
  published_segments: number
}

export interface FirstRunStatus {
  required: boolean
  completed: boolean
  config_path: string
  detected: PortableWorkbenchConfig
  checks: Array<{ id: string; status: 'ok' | 'warning' | 'error'; message: string }>
  system?: {
    windows: string
    cpu: string
    logical_cores: number
    ram_gb: number
    disk_free_gb: number | null
    gpu: { available: boolean; name: string | null; vram_mb: number | null }
  }
  ollama?: {
    status: 'running' | 'installed_stopped' | 'not_detected'
    endpoint: string
    executable_detected: boolean
  }
  models?: Array<{ id: string; role: 'general' | 'embedding' | 'code'; required: boolean; installed: boolean }>
  media_summary?: { status: 'gpu' | 'cpu' | 'not_installed'; ffmpeg: boolean; ytdlp: boolean; asr: boolean; ocr: boolean }
  data_root?: string
  desktop?: boolean
}

export interface FirstRunSmokeResult {
  chat: { ok: boolean; model: string; response: string | null; error: string | null }
  embedding: { ok: boolean; model: string; dimensions: number | null; finite: boolean; error: string | null }
}

export interface BackupManifest {
  id: string
  created_at: string
  backup_root: string
  files: Array<{ role: 'workbench' | 'research-memory'; source_path: string; backup_path: string; sha256: string; size_bytes: number; integrity_check: string }>
  manifest_path: string
  verified: boolean
}

export interface DistributionStatus {
  app_version: string
  portable: boolean
  first_run: FirstRunStatus
  backup_count: number
  latest_backup: BackupManifest | null
  release_package: { path: string | null; exists: boolean; sha256: string | null; created_at: string | null }
  media: VideoCapabilityStatus
  desktop?: { enabled: boolean; version: string; build_id: string; data_root: string; log_root: string }
}

export interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}
