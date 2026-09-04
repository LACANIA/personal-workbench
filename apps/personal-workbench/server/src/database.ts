import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AssetInventoryResult,
} from './assets/inventory.ts'
import type {
  ArtifactQuery,
  ArtifactEvidenceLinkRecord,
  ArtifactEvidenceRelationType,
  ArtifactEvidenceSourceType,
  EvidenceAuditIssue,
  EvidenceAuditStatus,
  ArtifactRecord,
  ArtifactStatus,
  ArtifactVersionLinkRecord,
  ArtifactVersionRecord,
  ProvenanceAuditRecord,
  ReviewDecision,
  ReviewDecisionRecord,
  ReviewInvalidation,
  ReviewInvalidationReason,
  ReviewSnapshotDetail,
  ReviewerProfile,
  ReviewerRole,
  ReviewPolicy,
  ReviewPolicyType,
  ProjectAssetSnapshot,
  ProjectContext,
  ProjectDetection,
  ProjectMemoryReference,
  ProjectType,
  InputAsset,
  InputAssetType,
  InputAccessMode,
  InputSourceMode,
  TemporaryInputGrant,
  InputGrantScope,
  KnowledgeIngestionPipeline,
  KnowledgeIngestionRecord,
  KnowledgeSourceType,
  UnifiedDocumentRecord,
  LearningDocumentRecord,
  TaskCreateInput,
  TaskEvent,
  TaskRuntimeStage,
  TaskRuntimeState,
  TaskRuntimeStatus,
  TaskStatus,
  WorkbenchTask,
  TaskOrigin,
} from '../../shared/contracts/index.ts'
import { PATHS, profileForTemplate } from './config.ts'
import { sanitizeHarnessNotification } from './security/redaction.ts'

function now(): string {
  return new Date().toISOString()
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null || value.length === 0) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function pathKey(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function pathBelongsToRoot(candidate: string, root: string): boolean {
  const candidateKey = pathKey(candidate)
  const rootKey = pathKey(root)
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${path.sep}`)
}

export class WorkbenchDatabase {
  readonly db: DatabaseSync

  constructor(readonly databasePath = PATHS.workbenchDb) {
    mkdirSync(path.dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_contexts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        project_type TEXT NOT NULL CHECK(project_type IN ('personal','node','python','mixed','research','software','documentation','general')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_scan_at TEXT
      );
      CREATE TABLE IF NOT EXISTS workbench_tasks (
        id TEXT PRIMARY KEY,
        task_origin TEXT NOT NULL DEFAULT 'legacy' CHECK(task_origin IN ('user','validation','system','legacy')),
        hidden_at TEXT,
        project_id TEXT REFERENCES project_contexts(id) ON DELETE SET NULL,
        template_id TEXT NOT NULL,
        title TEXT NOT NULL,
        input_type TEXT NOT NULL,
        input_value TEXT NOT NULL,
        workspace_path TEXT,
        project_name TEXT,
        profile TEXT NOT NULL,
        permission_mode TEXT NOT NULL CHECK(permission_mode = 'read-only'),
        status TEXT NOT NULL CHECK(status IN ('created','validating','queued','starting','running','completed','failed','canceled')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        harness_session_id TEXT,
        runtime_pid INTEGER,
        result_text TEXT,
        error_code TEXT,
        error_message TEXT,
        artifact_index_json TEXT NOT NULL DEFAULT '[]',
        citation_index_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('workbench','harness')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_events_task_id_id ON task_events(task_id, id);
      CREATE TABLE IF NOT EXISTS task_runtime_states (
        task_id TEXT PRIMARY KEY REFERENCES workbench_tasks(id) ON DELETE CASCADE,
        task_type TEXT NOT NULL,
        current_stage TEXT NOT NULL CHECK(current_stage IN ('created','initializing','detecting_source','adapting','fetching','processing','transcribing','segmenting','embedding','extracting','generating','learning_document_planning','learning_document_generating','docx_rendering','output_ready','review','completed','failed')),
        progress INTEGER NOT NULL CHECK(progress >= 0 AND progress <= 100),
        status TEXT NOT NULL CHECK(status IN ('created','running','completed','failed','canceled')),
        message TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        finished_at TEXT,
        active_model TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_runtime_states_status_updated ON task_runtime_states(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_ingestion_sources (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES workbench_tasks(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES project_contexts(id) ON DELETE SET NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('local_file','local_folder','video_url','web_url','github_repo','text_input')),
        source_reference TEXT NOT NULL,
        display_name TEXT NOT NULL,
        pipeline TEXT NOT NULL CHECK(pipeline IN ('video_knowledge','file_analysis','folder_inventory','web_knowledge','github_knowledge','document_knowledge','source_registration')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_ingestion_sources_project_created ON knowledge_ingestion_sources(project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS unified_documents (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES workbench_tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK(source_type IN ('web_url','github_repo','local_file')),
        source_url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        site_name TEXT,
        description TEXT,
        language TEXT,
        content_type TEXT NOT NULL,
        content TEXT NOT NULL,
        sections_json TEXT NOT NULL DEFAULT '[]',
        code_blocks_json TEXT NOT NULL DEFAULT '[]',
        links_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        acquired_at TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64)
      );
      CREATE INDEX IF NOT EXISTS unified_documents_project_acquired ON unified_documents(project_id, acquired_at DESC);
      CREATE INDEX IF NOT EXISTS unified_documents_identity ON unified_documents(project_id, canonical_url, content_sha256);
      CREATE TABLE IF NOT EXISTS document_chunk_indexes (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES unified_documents(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL CHECK(chunk_index > 0),
        section_title TEXT NOT NULL DEFAULT '',
        source_anchor TEXT NOT NULL,
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
        provider TEXT NOT NULL CHECK(provider IN ('ollama','local-hash-v1')),
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL CHECK(dimension BETWEEN 1 AND 4096),
        vector_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(document_id, chunk_index, provider, model, content_sha256)
      );
      CREATE INDEX IF NOT EXISTS document_chunk_indexes_document ON document_chunk_indexes(document_id, chunk_index);
      CREATE INDEX IF NOT EXISTS document_chunk_indexes_project ON document_chunk_indexes(project_id, provider, model);
      CREATE TABLE IF NOT EXISTS document_chunk_summaries (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES unified_documents(id) ON DELETE CASCADE,
        content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
        chunk_index INTEGER NOT NULL CHECK(chunk_index > 0),
        topic TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_points_json TEXT NOT NULL DEFAULT '[]',
        terms_json TEXT NOT NULL DEFAULT '[]',
        source_anchors_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('completed','failed','canceled')),
        created_at TEXT NOT NULL,
        UNIQUE(document_id, content_sha256, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS document_section_summaries (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES unified_documents(id) ON DELETE CASCADE,
        content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
        section_index INTEGER NOT NULL CHECK(section_index > 0),
        section_title TEXT NOT NULL,
        overview TEXT NOT NULL,
        key_points_json TEXT NOT NULL DEFAULT '[]',
        important_terms_json TEXT NOT NULL DEFAULT '[]',
        source_range TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(document_id, content_sha256, section_index)
      );
      CREATE TABLE IF NOT EXISTS file_organization_plans (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        root_path TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('light','smart','project')),
        operations_json TEXT NOT NULL DEFAULT '[]', scan_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('draft','reviewed','approved','executing','completed','completed_with_errors','failed','undone')),
        created_at TEXT NOT NULL, approved_at TEXT, executed_at TEXT, undone_at TEXT
      );
      CREATE INDEX IF NOT EXISTS file_organization_plans_task ON file_organization_plans(task_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS file_content_profiles (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL COLLATE NOCASE,
        file_path_relative TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        file_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        keywords_json TEXT NOT NULL,
        detected_topic TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(root_path, file_path_relative, content_hash)
      );
      CREATE INDEX IF NOT EXISTS file_content_profiles_root_file ON file_content_profiles(root_path, file_path_relative);
      CREATE TABLE IF NOT EXISTS file_organizer_rules (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL CHECK(length(pattern) BETWEEN 1 AND 160),
        destination_relative_path TEXT NOT NULL CHECK(length(destination_relative_path) BETWEEN 1 AND 240),
        created_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
      );
      CREATE INDEX IF NOT EXISTS file_organizer_rules_enabled ON file_organizer_rules(enabled, created_at DESC);
      CREATE TABLE IF NOT EXISTS input_assets (
        id TEXT PRIMARY KEY,
        input_type TEXT NOT NULL CHECK(input_type IN ('file','directory','url','text')),
        display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 255),
        original_path TEXT COLLATE NOCASE,
        staged_path TEXT COLLATE NOCASE,
        access_mode TEXT NOT NULL CHECK(access_mode IN ('project','temporary_grant','staged_copy')),
        source_mode TEXT NOT NULL CHECK(source_mode IN ('native_picker','drag_drop','manual_path','url','project')),
        mime_type TEXT NOT NULL,
        size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
        sha256 TEXT CHECK(sha256 IS NULL OR length(sha256) = 64),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        task_id TEXT REFERENCES workbench_tasks(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES project_contexts(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        CHECK(original_path IS NOT NULL OR staged_path IS NOT NULL OR input_type IN ('url','text'))
      );
      CREATE TABLE IF NOT EXISTS temporary_input_grants (
        grant_id TEXT PRIMARY KEY,
        input_asset_id TEXT NOT NULL UNIQUE REFERENCES input_assets(id) ON DELETE CASCADE,
        selected_path TEXT NOT NULL COLLATE NOCASE,
        kind TEXT NOT NULL CHECK(kind IN ('file','directory')),
        scope TEXT NOT NULL CHECK(scope IN ('exact_file','directory_tree')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        task_id TEXT REFERENCES workbench_tasks(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK(status IN ('selected','granted','attached_to_task','expired')),
        source_mode TEXT NOT NULL CHECK(source_mode = 'native_picker')
      );
      CREATE TABLE IF NOT EXISTS workbench_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_asset_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        canonical_root TEXT NOT NULL,
        file_count INTEGER NOT NULL CHECK(file_count >= 0),
        directory_count INTEGER NOT NULL CHECK(directory_count >= 0),
        total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
        extension_distribution_json TEXT NOT NULL,
        recent_files_json TEXT NOT NULL,
        large_files_json TEXT NOT NULL,
        skipped_count INTEGER NOT NULL CHECK(skipped_count >= 0),
        duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
        detected_signals_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_memory_references (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        memory_role TEXT NOT NULL CHECK(memory_role IN ('production','test')),
        memory_project_name TEXT NOT NULL,
        memory_entity_type TEXT NOT NULL,
        memory_entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, memory_role, memory_entity_type, memory_entity_id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES workbench_tasks(id) ON DELETE SET NULL,
        artifact_type TEXT NOT NULL CHECK(artifact_type IN ('document','report','code','dataset','image','video','audio','log','analysis','other')),
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
        relative_path TEXT NOT NULL,
        absolute_path TEXT NOT NULL COLLATE NOCASE,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','missing','outdated','archived')),
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `)
    this.ensureTaskRuntimeStages()
    this.ensureKnowledgeIngestionPipelines()
    this.ensureUnifiedDocumentLocalFileSource()
    this.ensurePersonalProjectType()
    this.ensureProjectIdColumn()
    this.ensureTaskVisibilityColumns()
    this.ensureArtifactStatusColumn()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learning_documents (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_title TEXT NOT NULL,
        source_reference TEXT NOT NULL,
        document_title TEXT NOT NULL,
        document_mode TEXT NOT NULL CHECK(document_mode IN ('learning_notes','review_notes','technical_guide','simple_summary')),
        detail_level TEXT NOT NULL CHECK(detail_level IN ('concise','standard','detailed')),
        summary TEXT NOT NULL,
        content_json TEXT NOT NULL,
        json_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        docx_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        supersedes_document_id TEXT REFERENCES learning_documents(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS learning_documents_task_created ON learning_documents(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS learning_documents_project_created ON learning_documents(project_id, created_at DESC);
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL CHECK(version_number >= 1),
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        created_at TEXT NOT NULL,
        change_note TEXT NOT NULL DEFAULT '',
        UNIQUE(artifact_id, version_number)
      );
      CREATE TABLE IF NOT EXISTS artifact_version_links (
        id TEXT PRIMARY KEY,
        old_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        new_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK(relation = 'supersedes'),
        created_at TEXT NOT NULL,
        CHECK(old_artifact_id <> new_artifact_id),
        UNIQUE(old_artifact_id, new_artifact_id, relation)
      );
      CREATE TABLE IF NOT EXISTS artifact_evidence_links (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK(source_type IN ('task','session','memory','document_chunk','source','artifact')),
        source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 512),
        relation_type TEXT NOT NULL CHECK(relation_type IN ('generated_from','derived_from','references','verified_by','created_by')),
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(artifact_id, source_type, source_id, relation_type)
      );
      CREATE TABLE IF NOT EXISTS provenance_audit_records (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('healthy','warning','broken')),
        issues_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviewer_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
        role TEXT NOT NULL CHECK(role IN ('reviewer','lead_reviewer','research_reviewer','code_reviewer','knowledge_reviewer')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_policies (
        id TEXT PRIMARY KEY,
        policy_type TEXT NOT NULL CHECK(policy_type IN ('research','code','knowledge')),
        version TEXT NOT NULL CHECK(length(version) BETWEEN 1 AND 64),
        rules_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(policy_type, version)
      );
      CREATE TABLE IF NOT EXISTS review_decisions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK(decision IN ('pending','approved','rejected','needs_revision')),
        reviewer TEXT NOT NULL CHECK(length(reviewer) BETWEEN 1 AND 128),
        reviewer_id TEXT REFERENCES reviewer_profiles(id) ON DELETE RESTRICT,
        artifact_hash TEXT CHECK(artifact_hash IS NULL OR length(artifact_hash) = 64),
        evidence_hash TEXT CHECK(evidence_hash IS NULL OR length(evidence_hash) = 64),
        policy_type TEXT CHECK(policy_type IS NULL OR policy_type IN ('research','code','knowledge')),
        policy_version TEXT,
        recheck_of_review_id TEXT REFERENCES review_decisions(id) ON DELETE RESTRICT,
        note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 2000),
        created_at TEXT NOT NULL
      );
    `)
    this.ensureReviewSignatureColumns()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS review_invalidations (
        id TEXT PRIMARY KEY,
        review_decision_id TEXT NOT NULL REFERENCES review_decisions(id) ON DELETE RESTRICT,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK(reason IN ('artifact_hash_changed','evidence_hash_changed')),
        previous_hash TEXT NOT NULL CHECK(length(previous_hash) = 64),
        current_hash TEXT NOT NULL CHECK(length(current_hash) = 64),
        created_at TEXT NOT NULL,
        UNIQUE(review_decision_id, reason, current_hash)
      );
      CREATE TABLE IF NOT EXISTS review_snapshot_details (
        review_decision_id TEXT PRIMARY KEY REFERENCES review_decisions(id) ON DELETE CASCADE,
        artifact_snapshot_path TEXT,
        artifact_snapshot_sha256 TEXT CHECK(artifact_snapshot_sha256 IS NULL OR length(artifact_snapshot_sha256) = 64),
        artifact_snapshot_size INTEGER CHECK(artifact_snapshot_size IS NULL OR artifact_snapshot_size >= 0),
        artifact_snapshot_kind TEXT CHECK(artifact_snapshot_kind IS NULL OR artifact_snapshot_kind IN ('markdown','code','dataset')),
        evidence_snapshot_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
    `)
    this.seedReviewPolicies()
    this.backfillArtifactVersions()
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS workbench_tasks_project_id_created_at ON workbench_tasks(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS input_assets_task_created ON input_assets(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS input_assets_project_created ON input_assets(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS temporary_input_grants_task_status ON temporary_input_grants(task_id, status);
      CREATE INDEX IF NOT EXISTS project_asset_snapshots_project_created ON project_asset_snapshots(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS project_memory_references_project ON project_memory_references(project_id);
      CREATE INDEX IF NOT EXISTS artifacts_project_created ON artifacts(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS artifacts_task_created ON artifacts(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS artifacts_type_created ON artifacts(artifact_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS artifacts_status_created ON artifacts(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS artifact_versions_artifact_number ON artifact_versions(artifact_id, version_number DESC);
      CREATE INDEX IF NOT EXISTS artifact_version_links_old ON artifact_version_links(old_artifact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS artifact_version_links_new ON artifact_version_links(new_artifact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS artifact_evidence_artifact_created ON artifact_evidence_links(artifact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS artifact_evidence_source_created ON artifact_evidence_links(source_type, source_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS provenance_audit_artifact_created ON provenance_audit_records(artifact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS review_decisions_artifact_created ON review_decisions(artifact_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS reviewer_profiles_role_name ON reviewer_profiles(role, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS review_policies_type_active ON review_policies(policy_type, active, version DESC);
      CREATE INDEX IF NOT EXISTS review_invalidations_artifact_created ON review_invalidations(artifact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS review_invalidations_review ON review_invalidations(review_decision_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS review_decisions_recheck_of ON review_decisions(recheck_of_review_id, created_at DESC);
    `)
    this.db.prepare(`
      INSERT OR IGNORE INTO task_runtime_states(
        task_id, task_type, current_stage, progress, status, message, started_at, finished_at, active_model, updated_at
      )
      SELECT id, template_id, 'created', 0, 'created', '任务已经创建。', NULL, NULL, NULL, created_at
      FROM workbench_tasks
    `).run()
    this.applyPrivacyCompaction()
  }

  createTask(id: string, input: TaskCreateInput): WorkbenchTask {
    const databaseRole = input.databaseRole ?? 'production'
    const profile = profileForTemplate(input.templateId, databaseRole)
    const createdAt = now()
    const title = input.title?.trim() || `${input.templateId} · ${input.inputValue.slice(0, 64)}`
    const taskOrigin = input.taskOrigin ?? ((databaseRole === 'test' || /(?:step[-_ ]\d+|acceptance|benchmark|validation|验收)/iu.test(`${title} ${input.inputValue}`)) ? 'validation' : 'user')
    const inboxTask = input.workspacePath === undefined && input.projectName === undefined
      && (input.templateId === 'file-analysis' || input.inputAssetId !== undefined)
    const project = inboxTask ? this.getPersonalInboxProject() : this.findProjectForTaskInput(input)
    const projectId = project?.id ?? null
    const workspacePath = input.workspacePath ?? (inboxTask ? project?.rootPath : undefined) ?? null
    const projectName = input.projectName ?? (inboxTask ? project?.name : undefined) ?? null
    this.db.prepare(`
      INSERT INTO workbench_tasks (
        id, task_origin, hidden_at, project_id, template_id, title, input_type, input_value, workspace_path, project_name,
        profile, permission_mode, status, created_at, metadata_json
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'read-only', 'created', ?, ?)
    `).run(
      id,
      taskOrigin,
      projectId,
      input.templateId,
      title,
      input.inputType ?? 'text',
      input.inputValue,
      workspacePath,
      projectName,
      profile,
      createdAt,
      JSON.stringify({ databaseRole, ...(input.inputAssetId === undefined ? {} : { inputAssetId: input.inputAssetId }) }),
    )
    this.db.prepare(`
      INSERT INTO task_runtime_states(
        task_id, task_type, current_stage, progress, status, message, started_at, finished_at, active_model, updated_at
      ) VALUES (?, ?, 'created', 0, 'created', '任务已经创建。', NULL, NULL, NULL, ?)
    `).run(id, input.templateId, createdAt)
    this.addEvent(id, 'task.created', 'workbench', { templateId: input.templateId, databaseRole })
    return this.getTask(id)!
  }

  updateTask(id: string, patch: Partial<{
    status: TaskStatus
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
  }>): WorkbenchTask {
    const columns: string[] = []
    const values: (string | number | null)[] = []
    const mapping: Record<string, string> = {
      status: 'status', startedAt: 'started_at', completedAt: 'completed_at',
      harnessSessionId: 'harness_session_id', runtimePid: 'runtime_pid', resultText: 'result_text',
      errorCode: 'error_code', errorMessage: 'error_message', artifactIndex: 'artifact_index_json',
      citationIndex: 'citation_index_json', metadata: 'metadata_json',
    }
    for (const [key, value] of Object.entries(patch)) {
      const column = mapping[key]
      if (column === undefined) continue
      columns.push(`${column} = ?`)
      const stored = ['artifactIndex', 'citationIndex', 'metadata'].includes(key) ? JSON.stringify(value) : value
      if (stored !== null && typeof stored !== 'string' && typeof stored !== 'number') throw new Error(`INVALID_TASK_PATCH: ${key}`)
      values.push(stored)
    }
    if (columns.length > 0) this.db.prepare(`UPDATE workbench_tasks SET ${columns.join(', ')} WHERE id = ?`).run(...values, id)
    const task = this.getTask(id)
    if (task === undefined) throw new Error(`TASK_NOT_FOUND: ${id}`)
    return task
  }

  bindTaskToProject(id: string, projectId: string, workspacePath: string): WorkbenchTask {
    const project = this.getProjectContext(projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    this.db.prepare(`
      UPDATE workbench_tasks
      SET project_id = ?, workspace_path = ?, project_name = ?
      WHERE id = ?
    `).run(project.id, workspacePath, project.name, id)
    const task = this.getTask(id)
    if (task === undefined) throw new Error(`TASK_NOT_FOUND: ${id}`)
    return task
  }

  getTask(id: string): WorkbenchTask | undefined {
    const row = this.db.prepare('SELECT * FROM workbench_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapTask(row)
  }

  getTaskByHarnessSessionId(sessionId: string): WorkbenchTask | undefined {
    const row = this.db.prepare('SELECT * FROM workbench_tasks WHERE harness_session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapTask(row)
  }

  listTasks(limit = 100, options: { includeInternal?: boolean; includeHidden?: boolean; status?: string | undefined; search?: string | undefined } = {}): WorkbenchTask[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const clauses: string[] = []
    const values: (string | number)[] = []
    if (options.includeHidden !== true) clauses.push('hidden_at IS NULL')
    if (options.includeInternal !== true) {
      clauses.push("task_origin NOT IN ('validation', 'system') AND lower(title || ' ' || input_value) NOT LIKE '%step-%' AND lower(title || ' ' || input_value) NOT LIKE '%acceptance%' AND lower(title || ' ' || input_value) NOT LIKE '%benchmark%' AND lower(title || ' ' || input_value) NOT LIKE '%validation%' AND lower(title || ' ' || input_value) NOT LIKE '%验收%'")
    }
    if (options.status !== undefined && ['created','validating','queued','starting','running','completed','failed','canceled'].includes(options.status)) { clauses.push('status = ?'); values.push(options.status) }
    if (options.search !== undefined && options.search.trim().length > 0) { clauses.push("lower(title || ' ' || input_value) LIKE ?"); values.push(`%${options.search.trim().toLowerCase().slice(0, 120)}%`) }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM workbench_tasks${where} ORDER BY created_at DESC LIMIT ?`).all(...values, safeLimit) as Record<string, unknown>[]
    return rows.map(row => this.mapTask(row))
  }

  setTaskHidden(id: string, hidden: boolean): WorkbenchTask {
    const result = this.db.prepare('UPDATE workbench_tasks SET hidden_at = ? WHERE id = ?').run(hidden ? now() : null, id)
    if (Number(result.changes) !== 1) throw new Error(`TASK_NOT_FOUND: ${id}`)
    const task = this.getTask(id)
    if (task === undefined) throw new Error(`TASK_NOT_FOUND: ${id}`)
    return task
  }

  addEvent(taskId: string, eventType: string, source: 'workbench' | 'harness', payload: unknown): TaskEvent {
    const createdAt = now()
    const result = this.db.prepare(
      'INSERT INTO task_events(task_id, event_type, source, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(taskId, eventType, source, JSON.stringify(payload), createdAt)
    return {
      id: Number(result.lastInsertRowid),
      taskId,
      eventType,
      source,
      payload,
      createdAt,
    }
  }

  listEvents(taskId: string, afterId = 0): TaskEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC',
    ).all(taskId, afterId) as Record<string, unknown>[]
    return rows.map(row => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      eventType: String(row.event_type),
      source: row.source as 'workbench' | 'harness',
      payload: parseJson(String(row.payload_json), {}),
      createdAt: String(row.created_at),
    }))
  }

  getTaskRuntime(taskId: string): TaskRuntimeState | undefined {
    const row = this.db.prepare('SELECT * FROM task_runtime_states WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapTaskRuntime(row)
  }

  updateTaskRuntime(taskId: string, patch: Partial<{
    current_stage: TaskRuntimeStage
    progress: number
    status: TaskRuntimeStatus
    message: string
    started_at: string | null
    finished_at: string | null
    active_model: string | null
  }>): TaskRuntimeState {
    const current = this.getTaskRuntime(taskId)
    if (current === undefined) throw new Error(`TASK_RUNTIME_NOT_FOUND: ${taskId}`)
    const columns: string[] = []
    const values: Array<string | number | null> = []
    for (const [key, value] of Object.entries(patch)) {
      if (!['current_stage', 'progress', 'status', 'message', 'started_at', 'finished_at', 'active_model'].includes(key)) continue
      if (key === 'progress' && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100)) throw new Error('INVALID_RUNTIME_PROGRESS')
      if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new Error(`INVALID_RUNTIME_PATCH: ${key}`)
      columns.push(`${key} = ?`)
      values.push(value as string | number | null)
    }
    columns.push('updated_at = ?')
    values.push(now())
    this.db.prepare(`UPDATE task_runtime_states SET ${columns.join(', ')} WHERE task_id = ?`).run(...values, taskId)
    return this.getTaskRuntime(taskId)!
  }

  listActiveTaskRuntimes(limit = 10): TaskRuntimeState[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
    const rows = this.db.prepare("SELECT * FROM task_runtime_states WHERE status = 'running' ORDER BY updated_at DESC LIMIT ?").all(safeLimit) as Record<string, unknown>[]
    return rows.map(row => this.mapTaskRuntime(row))
  }

  runtimeIntegrity(): { integrity_check: string; foreign_key_check: unknown[] } {
    const integrity = this.db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all()
    return { integrity_check: String(integrity.integrity_check ?? integrity[Object.keys(integrity)[0]!] ?? ''), foreign_key_check: foreignKeys }
  }

  createKnowledgeIngestionSource(record: KnowledgeIngestionRecord): KnowledgeIngestionRecord {
    this.db.prepare(`
      INSERT INTO knowledge_ingestion_sources(
        id, task_id, project_id, source_type, source_reference, display_name, pipeline, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.task_id, record.project_id, record.source_type, record.source_reference,
      record.display_name, record.pipeline, JSON.stringify(record.metadata), record.created_at,
    )
    return this.getKnowledgeIngestionSource(record.id)!
  }

  getKnowledgeIngestionSource(id: string): KnowledgeIngestionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_ingestion_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapKnowledgeIngestionSource(row)
  }

  getKnowledgeIngestionSourceByTask(taskId: string): KnowledgeIngestionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_ingestion_sources WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapKnowledgeIngestionSource(row)
  }

  listKnowledgeIngestionSources(projectId?: string, limit = 100): KnowledgeIngestionRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = projectId === undefined
      ? this.db.prepare('SELECT * FROM knowledge_ingestion_sources ORDER BY created_at DESC LIMIT ?').all(safeLimit)
      : this.db.prepare('SELECT * FROM knowledge_ingestion_sources WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, safeLimit)
    return (rows as Record<string, unknown>[]).map(row => this.mapKnowledgeIngestionSource(row))
  }

  createUnifiedDocument(document: UnifiedDocumentRecord): UnifiedDocumentRecord {
    this.db.prepare(`
      INSERT INTO unified_documents(
        id, task_id, project_id, source_type, source_url, canonical_url, title, author, site_name,
        description, language, content_type, content, sections_json, code_blocks_json, links_json,
        metadata_json, acquired_at, content_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      document.id, document.task_id, document.project_id, document.source_type, document.source_url,
      document.canonical_url, document.title, document.author, document.site_name, document.description,
      document.language, document.content_type, document.content, JSON.stringify(document.sections),
      JSON.stringify(document.code_blocks), JSON.stringify(document.links), JSON.stringify(document.metadata),
      document.acquired_at, document.content_sha256,
    )
    return this.getUnifiedDocument(document.id)!
  }

  getUnifiedDocument(id: string): UnifiedDocumentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM unified_documents WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapUnifiedDocument(row)
  }

  getUnifiedDocumentByTask(taskId: string): UnifiedDocumentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM unified_documents WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapUnifiedDocument(row)
  }

  findUnifiedDocumentByIdentity(projectId: string, canonicalUrl: string, contentSha256: string): UnifiedDocumentRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM unified_documents
      WHERE project_id = ? AND canonical_url = ? AND content_sha256 = ?
      ORDER BY acquired_at DESC LIMIT 1
    `).get(projectId, canonicalUrl, contentSha256) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapUnifiedDocument(row)
  }

  createInputAsset(asset: InputAsset): InputAsset {
    this.db.prepare(`
      INSERT INTO input_assets(
        id, input_type, display_name, original_path, staged_path, access_mode, source_mode,
        mime_type, size_bytes, sha256, created_at, expires_at, task_id, project_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.id, asset.input_type, asset.display_name, asset.original_path, asset.staged_path,
      asset.access_mode, asset.source_mode, asset.mime_type, asset.size_bytes, asset.sha256,
      asset.created_at, asset.expires_at, asset.task_id, asset.project_id, JSON.stringify(asset.metadata),
    )
    return this.getInputAsset(asset.id)!
  }

  getInputAsset(id: string): InputAsset | undefined {
    const row = this.db.prepare('SELECT * FROM input_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapInputAsset(row)
  }

  listInputAssets(limit = 100): InputAsset[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    return (this.db.prepare('SELECT * FROM input_assets ORDER BY created_at DESC LIMIT ?').all(safeLimit) as Record<string, unknown>[])
      .map(row => this.mapInputAsset(row))
  }

  createTemporaryInputGrant(grant: TemporaryInputGrant): TemporaryInputGrant {
    if (grant.source_mode !== 'native_picker') throw new Error('INPUT_GRANT_SOURCE_DENIED')
    this.db.prepare(`
      INSERT INTO temporary_input_grants(
        grant_id, input_asset_id, selected_path, kind, scope, created_at, expires_at, task_id, status, source_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      grant.grant_id, grant.input_asset_id, grant.selected_path, grant.kind, grant.scope,
      grant.created_at, grant.expires_at, grant.task_id, grant.status, grant.source_mode,
    )
    return this.getTemporaryInputGrant(grant.grant_id)!
  }

  getTemporaryInputGrant(id: string): TemporaryInputGrant | undefined {
    const row = this.db.prepare('SELECT * FROM temporary_input_grants WHERE grant_id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapTemporaryInputGrant(row)
  }

  getInputGrantForAsset(inputAssetId: string): TemporaryInputGrant | undefined {
    const row = this.db.prepare('SELECT * FROM temporary_input_grants WHERE input_asset_id = ?').get(inputAssetId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapTemporaryInputGrant(row)
  }

  attachInputAssetToTask(inputAssetId: string, taskId: string, projectId: string | null): { asset: InputAsset; grant: TemporaryInputGrant | null } {
    const asset = this.getInputAsset(inputAssetId)
    if (asset === undefined) throw new Error('INPUT_ASSET_NOT_FOUND')
    if (asset.task_id !== null && asset.task_id !== taskId) throw new Error('INPUT_ASSET_ALREADY_ATTACHED')
    const grant = this.getInputGrantForAsset(inputAssetId)
    if (grant !== undefined) {
      if (grant.source_mode !== 'native_picker') throw new Error('INPUT_GRANT_SOURCE_DENIED')
      if (grant.status === 'expired' || Date.parse(grant.expires_at) <= Date.now()) throw new Error('INPUT_GRANT_EXPIRED')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE input_assets SET task_id = ?, project_id = ? WHERE id = ?').run(taskId, projectId, inputAssetId)
      if (grant !== undefined) {
        this.db.prepare("UPDATE temporary_input_grants SET task_id = ?, status = 'attached_to_task' WHERE grant_id = ?").run(taskId, grant.grant_id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { asset: this.getInputAsset(inputAssetId)!, grant: grant === undefined ? null : this.getTemporaryInputGrant(grant.grant_id)! }
  }

  promoteInputAssetToProject(inputAssetId: string, projectId: string): InputAsset {
    const asset = this.getInputAsset(inputAssetId)
    const project = this.getProjectContext(projectId)
    if (asset === undefined) throw new Error('INPUT_ASSET_NOT_FOUND')
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    if (asset.source_mode !== 'native_picker' || asset.input_type !== 'directory') throw new Error('PROJECT_INPUT_AUTHORIZATION_REQUIRED')
    const grant = this.getInputGrantForAsset(inputAssetId)
    if (grant === undefined || grant.scope !== 'directory_tree' || grant.status === 'expired') throw new Error('PROJECT_INPUT_AUTHORIZATION_REQUIRED')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare("UPDATE input_assets SET access_mode = 'project', project_id = ?, expires_at = NULL WHERE id = ?").run(projectId, inputAssetId)
      this.db.prepare("UPDATE temporary_input_grants SET status = 'expired', expires_at = ? WHERE grant_id = ?").run(now(), grant.grant_id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getInputAsset(inputAssetId)!
  }

  expireInputGrantForTask(taskId: string): TemporaryInputGrant[] {
    const rows = this.db.prepare("SELECT * FROM temporary_input_grants WHERE task_id = ? AND status <> 'expired'").all(taskId) as Record<string, unknown>[]
    if (rows.length === 0) return []
    this.db.prepare("UPDATE temporary_input_grants SET status = 'expired', expires_at = ? WHERE task_id = ? AND status <> 'expired'").run(now(), taskId)
    return rows.map(row => this.getTemporaryInputGrant(String(row.grant_id))!)
  }

  deleteUnusedInputAsset(id: string): InputAsset {
    const asset = this.getInputAsset(id)
    if (asset === undefined) throw new Error('INPUT_ASSET_NOT_FOUND')
    if (asset.task_id !== null) throw new Error('INPUT_ASSET_IN_USE')
    this.db.prepare('DELETE FROM input_assets WHERE id = ?').run(id)
    return asset
  }

  createArtifact(
    artifact: ArtifactRecord,
    version: ArtifactVersionRecord,
    link?: ArtifactVersionLinkRecord,
  ): ArtifactRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO artifacts(
          id, project_id, task_id, artifact_type, name, relative_path, absolute_path,
          mime_type, size_bytes, sha256, status, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id,
        artifact.project_id,
        artifact.task_id,
        artifact.artifact_type,
        artifact.name,
        artifact.relative_path,
        artifact.absolute_path,
        artifact.mime_type,
        artifact.size_bytes,
        artifact.sha256,
        artifact.status,
        artifact.created_at,
        JSON.stringify(artifact.metadata),
      )
      this.db.prepare(`
        INSERT INTO artifact_versions(id, artifact_id, version_number, sha256, size_bytes, created_at, change_note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(version.id, version.artifact_id, version.version_number, version.sha256, version.size_bytes, version.created_at, version.change_note)
      if (link !== undefined) {
        this.db.prepare(`
          INSERT INTO artifact_version_links(id, old_artifact_id, new_artifact_id, relation, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(link.id, link.old_artifact_id, link.new_artifact_id, link.relation, link.created_at)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getArtifact(artifact.id)!
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapArtifact(row)
  }

  findArtifactByIdentity(projectId: string, taskId: string | null, absolutePath: string, sha256: string): ArtifactRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM artifacts
      WHERE project_id = ? AND absolute_path = ? COLLATE NOCASE AND sha256 = ?
        AND ((task_id IS NULL AND ? IS NULL) OR task_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(projectId, absolutePath, sha256, taskId, taskId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapArtifact(row)
  }

  listArtifacts(filters: ArtifactQuery = {}): ArtifactRecord[] {
    const conditions: string[] = []
    const values: (string | number)[] = []
    if (filters.project_id !== undefined) { conditions.push('project_id = ?'); values.push(filters.project_id) }
    if (filters.task_id !== undefined) { conditions.push('task_id = ?'); values.push(filters.task_id) }
    if (filters.artifact_type !== undefined) { conditions.push('artifact_type = ?'); values.push(filters.artifact_type) }
    if (filters.status !== undefined) { conditions.push('status = ?'); values.push(filters.status) }
    const normalizedLimit = Number.isFinite(filters.limit) ? Math.trunc(filters.limit!) : 100
    const safeLimit = Math.max(1, Math.min(500, normalizedLimit))
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const rows = this.db.prepare(`SELECT * FROM artifacts ${where} ORDER BY created_at DESC, id ASC LIMIT ?`).all(...values, safeLimit) as Record<string, unknown>[]
    return rows.map(row => this.mapArtifact(row))
  }

  deleteArtifact(id: string): number {
    return Number(this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id).changes)
  }

  updateArtifactStatus(id: string, status: ArtifactStatus, metadata: Record<string, unknown>): ArtifactRecord {
    const result = this.db.prepare('UPDATE artifacts SET status = ?, metadata_json = ? WHERE id = ?').run(status, JSON.stringify(metadata), id)
    if (Number(result.changes) === 0) throw new Error('ARTIFACT_NOT_FOUND')
    return this.getArtifact(id)!
  }

  acceptArtifactRevision(input: {
    id: string
    artifact_id: string
    sha256: string
    size_bytes: number
    created_at: string
    change_note: string
    metadata: Record<string, unknown>
  }): ArtifactVersionRecord {
    const artifact = this.getArtifact(input.artifact_id)
    if (artifact === undefined) throw new Error('ARTIFACT_NOT_FOUND')
    const versionNumber = this.nextArtifactVersionNumber(artifact.id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO artifact_versions(id, artifact_id, version_number, sha256, size_bytes, created_at, change_note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.id, artifact.id, versionNumber, input.sha256, input.size_bytes, input.created_at, input.change_note)
      this.db.prepare(`
        UPDATE artifacts
        SET sha256 = ?, size_bytes = ?, status = 'active', metadata_json = ?
        WHERE id = ?
      `).run(input.sha256, input.size_bytes, JSON.stringify(input.metadata), artifact.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.listArtifactVersions([artifact.id]).find(version => version.id === input.id)!
  }

  getArtifactLineageIds(id: string): string[] {
    const exists = this.db.prepare('SELECT 1 FROM artifacts WHERE id = ?').get(id)
    if (exists === undefined) throw new Error('ARTIFACT_NOT_FOUND')
    const seen = new Set<string>([id])
    const queue = [id]
    const links = this.db.prepare(`
      SELECT old_artifact_id, new_artifact_id
      FROM artifact_version_links
      WHERE old_artifact_id = ? OR new_artifact_id = ?
    `)
    while (queue.length > 0) {
      const current = queue.shift()!
      const rows = links.all(current, current) as { old_artifact_id: string; new_artifact_id: string }[]
      for (const row of rows) {
        for (const candidate of [row.old_artifact_id, row.new_artifact_id]) {
          if (!seen.has(candidate)) { seen.add(candidate); queue.push(candidate) }
        }
      }
    }
    return [...seen]
  }

  listArtifactVersions(artifactIds: string[]): ArtifactVersionRecord[] {
    if (artifactIds.length === 0) return []
    const placeholders = artifactIds.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT * FROM artifact_versions
      WHERE artifact_id IN (${placeholders})
      ORDER BY version_number ASC, created_at ASC, id ASC
    `).all(...artifactIds) as Record<string, unknown>[]
    return rows.map(row => this.mapArtifactVersion(row))
  }

  listArtifactVersionLinks(artifactIds: string[]): ArtifactVersionLinkRecord[] {
    if (artifactIds.length === 0) return []
    const placeholders = artifactIds.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT * FROM artifact_version_links
      WHERE old_artifact_id IN (${placeholders}) OR new_artifact_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `).all(...artifactIds, ...artifactIds) as Record<string, unknown>[]
    return rows.map(row => this.mapArtifactVersionLink(row))
  }

  listArtifactRecordsByIds(artifactIds: string[]): ArtifactRecord[] {
    if (artifactIds.length === 0) return []
    const placeholders = artifactIds.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT * FROM artifacts WHERE id IN (${placeholders})`).all(...artifactIds) as Record<string, unknown>[]
    return rows.map(row => this.mapArtifact(row))
  }

  nextArtifactVersionNumber(id: string): number {
    const lineage = this.getArtifactLineageIds(id)
    const versions = this.listArtifactVersions(lineage)
    return versions.reduce((maximum, version) => Math.max(maximum, version.version_number), 0) + 1
  }

  hasSupersedesPath(startId: string, targetId: string): boolean {
    const seen = new Set<string>()
    const queue = [startId]
    const next = this.db.prepare('SELECT new_artifact_id FROM artifact_version_links WHERE old_artifact_id = ?')
    while (queue.length > 0) {
      const current = queue.shift()!
      if (current === targetId) return true
      if (seen.has(current)) continue
      seen.add(current)
      const rows = next.all(current) as { new_artifact_id: string }[]
      for (const row of rows) queue.push(row.new_artifact_id)
    }
    return false
  }

  listProjectArtifactVersions(projectId: string): Array<ArtifactVersionRecord & { artifact_name: string; artifact_type: ArtifactRecord['artifact_type'] }> {
    const rows = this.db.prepare(`
      SELECT av.*, a.name AS artifact_name, a.artifact_type
      FROM artifact_versions av
      JOIN artifacts a ON a.id = av.artifact_id
      WHERE a.project_id = ?
      ORDER BY av.created_at DESC, av.id ASC
    `).all(projectId) as Record<string, unknown>[]
    return rows.map(row => ({ ...this.mapArtifactVersion(row), artifact_name: String(row.artifact_name), artifact_type: row.artifact_type as ArtifactRecord['artifact_type'] }))
  }

  createArtifactEvidenceLink(link: ArtifactEvidenceLinkRecord): ArtifactEvidenceLinkRecord {
    this.db.prepare(`
      INSERT INTO artifact_evidence_links(
        id, artifact_id, source_type, source_id, relation_type, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_id, source_type, source_id, relation_type) DO NOTHING
    `).run(link.id, link.artifact_id, link.source_type, link.source_id, link.relation_type, link.created_at, JSON.stringify(link.metadata))
    const row = this.db.prepare(`
      SELECT * FROM artifact_evidence_links
      WHERE artifact_id = ? AND source_type = ? AND source_id = ? AND relation_type = ?
    `).get(link.artifact_id, link.source_type, link.source_id, link.relation_type) as Record<string, unknown>
    return this.mapArtifactEvidenceLink(row)
  }

  getArtifactEvidenceLink(id: string): ArtifactEvidenceLinkRecord | undefined {
    const row = this.db.prepare('SELECT * FROM artifact_evidence_links WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapArtifactEvidenceLink(row)
  }

  listArtifactEvidenceLinks(artifactId: string): ArtifactEvidenceLinkRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM artifact_evidence_links
      WHERE artifact_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(artifactId) as Record<string, unknown>[]
    return rows.map(row => this.mapArtifactEvidenceLink(row))
  }

  listEvidenceLinksBySource(sourceType: ArtifactEvidenceSourceType, sourceId: string): ArtifactEvidenceLinkRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM artifact_evidence_links
      WHERE source_type = ? AND source_id = ?
      ORDER BY created_at DESC, id ASC
    `).all(sourceType, sourceId) as Record<string, unknown>[]
    return rows.map(row => this.mapArtifactEvidenceLink(row))
  }

  listProjectArtifactEvidence(projectId: string, limit = 100): Array<ArtifactEvidenceLinkRecord & { artifact_name: string; artifact_type: ArtifactRecord['artifact_type'] }> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = this.db.prepare(`
      SELECT ael.*, a.name AS artifact_name, a.artifact_type
      FROM artifact_evidence_links ael
      JOIN artifacts a ON a.id = ael.artifact_id
      WHERE a.project_id = ?
      ORDER BY ael.created_at DESC, ael.id ASC
      LIMIT ?
    `).all(projectId, safeLimit) as Record<string, unknown>[]
    return rows.map(row => ({
      ...this.mapArtifactEvidenceLink(row),
      artifact_name: String(row.artifact_name),
      artifact_type: row.artifact_type as ArtifactRecord['artifact_type'],
    }))
  }

  deleteArtifactEvidenceLink(id: string): number {
    return Number(this.db.prepare('DELETE FROM artifact_evidence_links WHERE id = ?').run(id).changes)
  }

  createProvenanceAuditRecord(record: ProvenanceAuditRecord): ProvenanceAuditRecord {
    this.db.prepare(`
      INSERT INTO provenance_audit_records(id, artifact_id, status, issues_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.id, record.artifact_id, record.status, JSON.stringify(record.issues), record.created_at)
    return this.getProvenanceAuditRecord(record.id)!
  }

  getProvenanceAuditRecord(id: string): ProvenanceAuditRecord | undefined {
    const row = this.db.prepare('SELECT * FROM provenance_audit_records WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapProvenanceAuditRecord(row)
  }

  listArtifactProvenanceAudits(artifactId: string, limit = 100): ProvenanceAuditRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = this.db.prepare(`
      SELECT * FROM provenance_audit_records
      WHERE artifact_id = ?
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `).all(artifactId, safeLimit) as Record<string, unknown>[]
    return rows.map(row => this.mapProvenanceAuditRecord(row))
  }

  listProjectProvenanceAudits(projectId: string, limit = 100): Array<ProvenanceAuditRecord & { artifact_name: string; artifact_type: ArtifactRecord['artifact_type'] }> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = this.db.prepare(`
      SELECT par.*, a.name AS artifact_name, a.artifact_type
      FROM provenance_audit_records par
      JOIN artifacts a ON a.id = par.artifact_id
      WHERE a.project_id = ?
      ORDER BY par.created_at DESC, par.id ASC
      LIMIT ?
    `).all(projectId, safeLimit) as Record<string, unknown>[]
    return rows.map(row => ({
      ...this.mapProvenanceAuditRecord(row),
      artifact_name: String(row.artifact_name),
      artifact_type: row.artifact_type as ArtifactRecord['artifact_type'],
    }))
  }

  createReviewerProfile(profile: ReviewerProfile): ReviewerProfile {
    this.db.prepare(`
      INSERT INTO reviewer_profiles(id, name, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(profile.id, profile.name, profile.role, profile.created_at, profile.updated_at)
    return this.getReviewerProfile(profile.id)!
  }

  getReviewerProfile(id: string): ReviewerProfile | undefined {
    const row = this.db.prepare('SELECT * FROM reviewer_profiles WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapReviewerProfile(row)
  }

  findReviewerProfileByName(name: string): ReviewerProfile | undefined {
    const row = this.db.prepare('SELECT * FROM reviewer_profiles WHERE name = ? COLLATE NOCASE ORDER BY created_at ASC LIMIT 1').get(name) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapReviewerProfile(row)
  }

  listReviewerProfiles(): ReviewerProfile[] {
    const rows = this.db.prepare('SELECT * FROM reviewer_profiles ORDER BY name COLLATE NOCASE, id').all() as Record<string, unknown>[]
    return rows.map(row => this.mapReviewerProfile(row))
  }

  getReviewPolicy(policyType: ReviewPolicyType, version?: string): ReviewPolicy | undefined {
    const row = version === undefined
      ? this.db.prepare('SELECT * FROM review_policies WHERE policy_type = ? AND active = 1 ORDER BY updated_at DESC, version DESC LIMIT 1').get(policyType)
      : this.db.prepare('SELECT * FROM review_policies WHERE policy_type = ? AND version = ? LIMIT 1').get(policyType, version)
    return row === undefined ? undefined : this.mapReviewPolicy(row as Record<string, unknown>)
  }

  listReviewPolicies(activeOnly = true): ReviewPolicy[] {
    const rows = this.db.prepare(`SELECT * FROM review_policies ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY policy_type, version DESC`).all() as Record<string, unknown>[]
    return rows.map(row => this.mapReviewPolicy(row))
  }

  createReviewDecision(record: ReviewDecisionRecord): ReviewDecisionRecord {
    this.db.prepare(`
      INSERT INTO review_decisions(
        id, artifact_id, decision, reviewer, reviewer_id, artifact_hash, evidence_hash,
        policy_type, policy_version, recheck_of_review_id, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.artifact_id, record.decision, record.reviewer, record.reviewer_id ?? null,
      record.artifact_hash ?? null, record.evidence_hash ?? null, record.policy_type ?? null, record.policy_version ?? null,
      record.recheck_of_review_id ?? null,
      record.note, record.created_at,
    )
    return this.getReviewDecision(record.id)!
  }

  getReviewDecision(id: string): ReviewDecisionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM review_decisions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapReviewDecision(row)
  }

  getLatestArtifactReviewDecision(artifactId: string): ReviewDecisionRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM review_decisions
      WHERE artifact_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(artifactId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapReviewDecision(row)
  }

  listArtifactReviewDecisions(artifactId: string, limit = 100): ReviewDecisionRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = this.db.prepare(`
      SELECT * FROM review_decisions
      WHERE artifact_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(artifactId, safeLimit) as Record<string, unknown>[]
    return rows.map(row => this.mapReviewDecision(row))
  }

  listProjectLatestReviewDecisions(projectId: string): ReviewDecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT id, artifact_id, decision, reviewer, reviewer_id, artifact_hash, evidence_hash,
        policy_type, policy_version, recheck_of_review_id, note, created_at
      FROM (
        SELECT rd.*,
          ROW_NUMBER() OVER (PARTITION BY rd.artifact_id ORDER BY rd.created_at DESC, rd.id DESC) AS row_number
        FROM review_decisions rd
        JOIN artifacts a ON a.id = rd.artifact_id
        WHERE a.project_id = ?
      ) ranked
      WHERE row_number = 1
      ORDER BY created_at DESC, id DESC
    `).all(projectId) as Record<string, unknown>[]
    return rows.map(row => this.mapReviewDecision(row))
  }

  createReviewInvalidation(record: ReviewInvalidation): ReviewInvalidation {
    this.db.prepare(`
      INSERT INTO review_invalidations(
        id, review_decision_id, artifact_id, reason, previous_hash, current_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_decision_id, reason, current_hash) DO NOTHING
    `).run(
      record.id, record.review_decision_id, record.artifact_id, record.reason,
      record.previous_hash, record.current_hash, record.created_at,
    )
    const row = this.db.prepare(`
      SELECT * FROM review_invalidations
      WHERE review_decision_id = ? AND reason = ? AND current_hash = ?
    `).get(record.review_decision_id, record.reason, record.current_hash) as Record<string, unknown>
    return this.mapReviewInvalidation(row)
  }

  listReviewInvalidations(artifactId: string, reviewDecisionId?: string): ReviewInvalidation[] {
    const rows = reviewDecisionId === undefined
      ? this.db.prepare('SELECT * FROM review_invalidations WHERE artifact_id = ? ORDER BY created_at DESC, id').all(artifactId)
      : this.db.prepare('SELECT * FROM review_invalidations WHERE artifact_id = ? AND review_decision_id = ? ORDER BY created_at DESC, id').all(artifactId, reviewDecisionId)
    return (rows as Record<string, unknown>[]).map(row => this.mapReviewInvalidation(row))
  }

  createReviewSnapshotDetail(detail: ReviewSnapshotDetail): ReviewSnapshotDetail {
    this.db.prepare(`
      INSERT INTO review_snapshot_details(
        review_decision_id, artifact_snapshot_path, artifact_snapshot_sha256,
        artifact_snapshot_size, artifact_snapshot_kind, evidence_snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      detail.review_decision_id,
      detail.artifact_snapshot_path,
      detail.artifact_snapshot_sha256,
      detail.artifact_snapshot_size,
      detail.artifact_snapshot_kind,
      JSON.stringify(detail.evidence_snapshot),
      detail.created_at,
    )
    return this.getReviewSnapshotDetail(detail.review_decision_id)!
  }

  getReviewSnapshotDetail(reviewDecisionId: string): ReviewSnapshotDetail | undefined {
    const row = this.db.prepare('SELECT * FROM review_snapshot_details WHERE review_decision_id = ?').get(reviewDecisionId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapReviewSnapshotDetail(row)
  }

  close(): void { this.db.close() }

  createProjectContext(id: string, input: { name: string; rootPath: string; description: string; projectType: ProjectType }): ProjectContext {
    const createdAt = now()
    this.db.prepare(`
      INSERT INTO project_contexts(id, name, root_path, description, project_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.rootPath, input.description, input.projectType, createdAt, createdAt)
    return this.getProjectContext(id)!
  }

  getProjectContext(id: string): ProjectContext | undefined {
    const row = this.db.prepare('SELECT * FROM project_contexts WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapProjectContext(row)
  }

  getProjectContextByRoot(rootPath: string): ProjectContext | undefined {
    const rows = this.db.prepare('SELECT * FROM project_contexts').all() as Record<string, unknown>[]
    const rootKey = pathKey(rootPath)
    const row = rows.find(item => pathKey(String(item.root_path)) === rootKey)
    return row === undefined ? undefined : this.mapProjectContext(row)
  }

  getProjectContextByName(name: string): ProjectContext | undefined {
    const row = this.db.prepare('SELECT * FROM project_contexts WHERE name = ? COLLATE NOCASE ORDER BY created_at ASC LIMIT 1').get(name) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapProjectContext(row)
  }

  getPersonalInboxProject(): ProjectContext | undefined {
    const row = this.db.prepare("SELECT * FROM project_contexts WHERE project_type = 'personal' AND name = 'Personal Inbox' COLLATE NOCASE ORDER BY created_at ASC LIMIT 1").get() as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapProjectContext(row)
  }

  createLearningDocument(document: LearningDocumentRecord): LearningDocumentRecord {
    this.db.prepare(`
      INSERT INTO learning_documents(
        id, task_id, project_id, source_type, source_title, source_reference,
        document_title, document_mode, detail_level, summary, content_json,
        json_artifact_id, docx_artifact_id, supersedes_document_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      document.id, document.task_id, document.project_id, document.source_type, document.source_title, document.source_reference,
      document.document_title, document.document_mode, document.detail_level, document.summary,
      JSON.stringify({
        sections: document.sections, learning_goals: document.learning_goals, key_points: document.key_points,
        terms: document.terms, formulas: document.formulas, code_examples: document.code_examples,
        confusions: document.confusions, review_questions: document.review_questions,
        learning_tips: document.learning_tips, references: document.references,
      }),
      document.json_artifact_id, document.docx_artifact_id, document.supersedes_document_id, document.created_at,
    )
    return this.getLearningDocument(document.id)!
  }

  getLearningDocument(id: string): LearningDocumentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM learning_documents WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.mapLearningDocument(row)
  }

  listLearningDocumentsForTask(taskId: string, limit = 50): LearningDocumentRecord[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)))
    const rows = this.db.prepare(`
      SELECT * FROM learning_documents WHERE task_id = ? ORDER BY created_at DESC, id ASC LIMIT ?
    `).all(taskId, safeLimit) as Record<string, unknown>[]
    return rows.map(row => this.mapLearningDocument(row))
  }

  listProjectContexts(): ProjectContext[] {
    const rows = this.db.prepare('SELECT * FROM project_contexts ORDER BY updated_at DESC, name ASC').all() as Record<string, unknown>[]
    return rows.map(row => this.mapProjectContext(row))
  }

  updateProjectAfterScan(id: string, projectType: ProjectType, scannedAt: string): ProjectContext {
    this.db.prepare('UPDATE project_contexts SET project_type = ?, updated_at = ?, last_scan_at = ? WHERE id = ?').run(projectType, scannedAt, scannedAt, id)
    const project = this.getProjectContext(id)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    return project
  }

  saveProjectAssetSnapshot(
    id: string,
    projectId: string,
    inventory: AssetInventoryResult,
    detectedSignals: ProjectDetection,
    createdAt: string,
  ): ProjectAssetSnapshot {
    this.db.prepare(`
      INSERT INTO project_asset_snapshots(
        id, project_id, canonical_root, file_count, directory_count, total_bytes,
        extension_distribution_json, recent_files_json, large_files_json,
        skipped_count, duration_ms, detected_signals_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, projectId, inventory.canonicalRoot, inventory.fileCount, inventory.directoryCount, inventory.totalBytes,
      JSON.stringify(inventory.extensionDistribution), JSON.stringify(inventory.recentFiles), JSON.stringify(inventory.largeFiles),
      inventory.skippedCount, inventory.durationMs, JSON.stringify(detectedSignals), createdAt,
    )
    return this.getLatestProjectAssetSnapshot(projectId)!
  }

  getLatestProjectAssetSnapshot(projectId: string): ProjectAssetSnapshot | null {
    const row = this.db.prepare('SELECT * FROM project_asset_snapshots WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(projectId) as Record<string, unknown> | undefined
    return row === undefined ? null : this.mapProjectAssetSnapshot(row)
  }

  listProjectAssetSnapshots(projectId: string, limit = 100): ProjectAssetSnapshot[] {
    const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100
    const safeLimit = Math.max(1, Math.min(500, normalizedLimit))
    const rows = this.db.prepare(`
      SELECT * FROM project_asset_snapshots
      WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(projectId, safeLimit) as Record<string, unknown>[]
    return rows.map(row => this.mapProjectAssetSnapshot(row))
  }

  listProjectTasks(projectId: string, limit = 10): WorkbenchTask[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
    const rows = this.db.prepare('SELECT * FROM workbench_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, safeLimit) as Record<string, unknown>[]
    return rows.map(row => this.mapTask(row))
  }

  countProjectTasks(projectId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM workbench_tasks WHERE project_id = ?').get(projectId) as { count: number }
    return Number(row.count)
  }

  upsertProjectMemoryReference(input: Omit<ProjectMemoryReference, 'createdAt'>): ProjectMemoryReference {
    const createdAt = now()
    this.db.prepare(`
      INSERT OR IGNORE INTO project_memory_references(
        id, project_id, memory_role, memory_project_name, memory_entity_type, memory_entity_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.projectId, input.memoryRole, input.memoryProjectName, input.memoryEntityType, input.memoryEntityId, createdAt)
    const row = this.db.prepare(`
      SELECT * FROM project_memory_references
      WHERE project_id = ? AND memory_role = ? AND memory_entity_type = ? AND memory_entity_id = ?
    `).get(input.projectId, input.memoryRole, input.memoryEntityType, input.memoryEntityId) as Record<string, unknown>
    return this.mapProjectMemoryReference(row)
  }

  listProjectMemoryReferences(projectId: string): ProjectMemoryReference[] {
    const rows = this.db.prepare('SELECT * FROM project_memory_references WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as Record<string, unknown>[]
    return rows.map(row => this.mapProjectMemoryReference(row))
  }

  deleteProjectMemoryReference(projectId: string, memoryEntityId: string, memoryRole?: ProjectMemoryReference['memoryRole']): number {
    const result = memoryRole === undefined
      ? this.db.prepare(`
          DELETE FROM project_memory_references
          WHERE project_id = ? AND memory_entity_type = 'project' AND memory_entity_id = ?
        `).run(projectId, memoryEntityId)
      : this.db.prepare(`
          DELETE FROM project_memory_references
          WHERE project_id = ? AND memory_role = ? AND memory_entity_type = 'project' AND memory_entity_id = ?
        `).run(projectId, memoryRole, memoryEntityId)
    return Number(result.changes)
  }

  linkExistingTasksToProject(projectId: string): number {
    const project = this.getProjectContext(projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const rows = this.db.prepare('SELECT id, input_type, input_value, workspace_path FROM workbench_tasks WHERE project_id IS NULL').all() as Record<string, unknown>[]
    const update = this.db.prepare('UPDATE workbench_tasks SET project_id = ? WHERE id = ?')
    let linked = 0
    for (const row of rows) {
      const candidate = row.workspace_path === null
        ? (['file', 'directory'].includes(String(row.input_type)) ? String(row.input_value) : null)
        : String(row.workspace_path)
      if (candidate !== null && path.isAbsolute(candidate) && pathBelongsToRoot(candidate, project.rootPath)) {
        update.run(projectId, String(row.id))
        linked += 1
      }
    }
    return linked
  }

  private applyPrivacyCompaction(): void {
    const completed = this.db.prepare("SELECT value FROM workbench_meta WHERE key = 'privacy_compaction_v1'").get()
    if (completed !== undefined) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare("DELETE FROM task_events WHERE event_type = 'assistant/chunk'").run()
      const rows = this.db.prepare("SELECT id, payload_json FROM task_events WHERE event_type IN ('tool/result','assistant/message')").all() as { id: number; payload_json: string }[]
      const update = this.db.prepare('UPDATE task_events SET payload_json = ? WHERE id = ?')
      for (const row of rows) {
        const parsed = parseJson<Record<string, unknown>>(row.payload_json, {})
        const sanitized = sanitizeHarnessNotification(parsed as { method: string; params: Record<string, unknown> })
        update.run(JSON.stringify(sanitized), row.id)
      }
      this.db.prepare("INSERT INTO workbench_meta(key, value) VALUES ('privacy_compaction_v1', ?)").run(now())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private ensurePersonalProjectType(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_contexts'").get() as { sql?: string } | undefined
    if (row?.sql?.includes("'personal'")) return
    this.db.exec('PRAGMA foreign_keys=OFF')
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS project_contexts_step_26_5;
        CREATE TABLE project_contexts_step_26_5 (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL COLLATE NOCASE UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          project_type TEXT NOT NULL CHECK(project_type IN ('personal','node','python','mixed','research','software','documentation','general')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_scan_at TEXT
        );
        INSERT INTO project_contexts_step_26_5(id, name, root_path, description, project_type, created_at, updated_at, last_scan_at)
        SELECT id, name, root_path, description, project_type, created_at, updated_at, last_scan_at FROM project_contexts;
        DROP TABLE project_contexts;
        ALTER TABLE project_contexts_step_26_5 RENAME TO project_contexts;
        COMMIT;
      `)
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* the transaction may already be closed */ }
      throw error
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON')
    }
    const violations = this.db.prepare('PRAGMA foreign_key_check').all()
    if (violations.length > 0) throw new Error('PERSONAL_PROJECT_TYPE_MIGRATION_FOREIGN_KEY_FAILED')
  }

  private ensureProjectIdColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info('workbench_tasks')").all() as { name: string }[]
    if (!columns.some(column => column.name === 'project_id')) {
      this.db.exec('ALTER TABLE workbench_tasks ADD COLUMN project_id TEXT REFERENCES project_contexts(id) ON DELETE SET NULL')
    }
  }

  private ensureTaskVisibilityColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info('workbench_tasks')").all() as { name: string }[]
    if (!columns.some(column => column.name === 'task_origin')) this.db.exec("ALTER TABLE workbench_tasks ADD COLUMN task_origin TEXT NOT NULL DEFAULT 'legacy' CHECK(task_origin IN ('user','validation','system','legacy'))")
    if (!columns.some(column => column.name === 'hidden_at')) this.db.exec('ALTER TABLE workbench_tasks ADD COLUMN hidden_at TEXT')
  }

  private ensureArtifactStatusColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info('artifacts')").all() as { name: string }[]
    if (!columns.some(column => column.name === 'status')) {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','missing','outdated','archived'))")
    }
  }

  private ensureTaskRuntimeStages(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_runtime_states'").get() as { sql?: string } | undefined
    if (row?.sql?.includes("'detecting_source'") && row.sql.includes("'adapting'") && row.sql.includes("'output_ready'") && row.sql.includes("'awaiting_confirmation'")) return
    if (row?.sql === undefined) throw new Error('TASK_RUNTIME_SCHEMA_NOT_FOUND')
    this.db.exec('PRAGMA foreign_keys=OFF')
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS task_runtime_states_step33;
        CREATE TABLE task_runtime_states_step33 (
          task_id TEXT PRIMARY KEY REFERENCES workbench_tasks(id) ON DELETE CASCADE,
          task_type TEXT NOT NULL,
          current_stage TEXT NOT NULL CHECK(current_stage IN ('created','initializing','detecting_source','adapting','fetching','processing','transcribing','segmenting','embedding','extracting','generating','learning_document_planning','learning_document_generating','docx_rendering','output_ready','scanning_files','analyzing_files','planning_organization','awaiting_confirmation','creating_directories','moving_files','review','completed','failed')),
          progress INTEGER NOT NULL CHECK(progress >= 0 AND progress <= 100),
          status TEXT NOT NULL CHECK(status IN ('created','running','completed','failed','canceled')),
          message TEXT NOT NULL DEFAULT '',
          started_at TEXT,
          finished_at TEXT,
          active_model TEXT,
          updated_at TEXT NOT NULL
        );
        INSERT INTO task_runtime_states_step33(
          task_id, task_type, current_stage, progress, status, message, started_at, finished_at, active_model, updated_at
        ) SELECT task_id, task_type, current_stage, progress, status, message, started_at, finished_at, active_model, updated_at
          FROM task_runtime_states;
        DROP TABLE task_runtime_states;
        ALTER TABLE task_runtime_states_step33 RENAME TO task_runtime_states;
        CREATE INDEX task_runtime_states_status_updated ON task_runtime_states(status, updated_at DESC);
        COMMIT;
      `)
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* transaction may already be closed */ }
      throw error
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON')
    }
    if (this.db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('TASK_RUNTIME_STAGE_MIGRATION_FOREIGN_KEY_FAILED')
  }

  private ensureKnowledgeIngestionPipelines(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_ingestion_sources'").get() as { sql?: string } | undefined
    if (row?.sql?.includes("'web_knowledge'") && row.sql.includes("'github_knowledge'") && row.sql.includes("'document_knowledge'")) return
    if (row?.sql === undefined) throw new Error('KNOWLEDGE_INGESTION_SCHEMA_NOT_FOUND')
    this.db.exec('PRAGMA foreign_keys=OFF')
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS knowledge_ingestion_sources_step35;
        CREATE TABLE knowledge_ingestion_sources_step35 (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE REFERENCES workbench_tasks(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES project_contexts(id) ON DELETE SET NULL,
          source_type TEXT NOT NULL CHECK(source_type IN ('local_file','local_folder','video_url','web_url','github_repo','text_input')),
          source_reference TEXT NOT NULL,
          display_name TEXT NOT NULL,
          pipeline TEXT NOT NULL CHECK(pipeline IN ('video_knowledge','file_analysis','folder_inventory','web_knowledge','github_knowledge','document_knowledge','source_registration')),
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        INSERT INTO knowledge_ingestion_sources_step35(
          id, task_id, project_id, source_type, source_reference, display_name, pipeline, metadata_json, created_at
        ) SELECT id, task_id, project_id, source_type, source_reference, display_name, pipeline, metadata_json, created_at
          FROM knowledge_ingestion_sources;
        DROP TABLE knowledge_ingestion_sources;
        ALTER TABLE knowledge_ingestion_sources_step35 RENAME TO knowledge_ingestion_sources;
        CREATE INDEX knowledge_ingestion_sources_project_created ON knowledge_ingestion_sources(project_id, created_at DESC);
        COMMIT;
      `)
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* transaction may already be closed */ }
      throw error
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON')
    }
    if (this.db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('KNOWLEDGE_INGESTION_MIGRATION_FOREIGN_KEY_FAILED')
  }

  private ensureUnifiedDocumentLocalFileSource(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'unified_documents'").get() as { sql?: string } | undefined
    if (row?.sql?.includes("'local_file'")) return
    if (row?.sql === undefined) throw new Error('UNIFIED_DOCUMENT_SCHEMA_NOT_FOUND')
    this.db.exec('PRAGMA foreign_keys=OFF')
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS unified_documents_step35;
        CREATE TABLE unified_documents_step35 (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE REFERENCES workbench_tasks(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL CHECK(source_type IN ('web_url','github_repo','local_file')),
          source_url TEXT NOT NULL,
          canonical_url TEXT NOT NULL,
          title TEXT NOT NULL,
          author TEXT,
          site_name TEXT,
          description TEXT,
          language TEXT,
          content_type TEXT NOT NULL,
          content TEXT NOT NULL,
          sections_json TEXT NOT NULL DEFAULT '[]',
          code_blocks_json TEXT NOT NULL DEFAULT '[]',
          links_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          acquired_at TEXT NOT NULL,
          content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64)
        );
        INSERT INTO unified_documents_step35(
          id, task_id, project_id, source_type, source_url, canonical_url, title, author, site_name, description,
          language, content_type, content, sections_json, code_blocks_json, links_json, metadata_json, acquired_at, content_sha256
        ) SELECT id, task_id, project_id, source_type, source_url, canonical_url, title, author, site_name, description,
          language, content_type, content, sections_json, code_blocks_json, links_json, metadata_json, acquired_at, content_sha256
          FROM unified_documents;
        DROP TABLE unified_documents;
        ALTER TABLE unified_documents_step35 RENAME TO unified_documents;
        CREATE INDEX unified_documents_project_acquired ON unified_documents(project_id, acquired_at DESC);
        CREATE INDEX unified_documents_identity ON unified_documents(project_id, canonical_url, content_sha256);
        COMMIT;
      `)
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* transaction may already be closed */ }
      throw error
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON')
    }
    if (this.db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('UNIFIED_DOCUMENT_MIGRATION_FOREIGN_KEY_FAILED')
  }

  private ensureReviewSignatureColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info('review_decisions')").all() as { name: string }[]
    const names = new Set(columns.map(column => column.name))
    const additions: Array<[string, string]> = [
      ['reviewer_id', 'TEXT REFERENCES reviewer_profiles(id) ON DELETE RESTRICT'],
      ['artifact_hash', 'TEXT CHECK(artifact_hash IS NULL OR length(artifact_hash) = 64)'],
      ['evidence_hash', 'TEXT CHECK(evidence_hash IS NULL OR length(evidence_hash) = 64)'],
      ['policy_type', "TEXT CHECK(policy_type IS NULL OR policy_type IN ('research','code','knowledge'))"],
      ['policy_version', 'TEXT'],
      ['recheck_of_review_id', 'TEXT REFERENCES review_decisions(id) ON DELETE RESTRICT'],
    ]
    for (const [name, definition] of additions) {
      if (!names.has(name)) this.db.exec(`ALTER TABLE review_decisions ADD COLUMN ${name} ${definition}`)
    }
  }

  private seedReviewPolicies(): void {
    const timestamp = now()
    const policies: Array<{ type: ReviewPolicyType; artifactTypes: ArtifactRecord['artifact_type'][]; roles: ReviewerRole[] }> = [
      { type: 'research', artifactTypes: ['document', 'report', 'dataset', 'analysis'], roles: ['reviewer', 'lead_reviewer', 'research_reviewer'] },
      { type: 'code', artifactTypes: ['code', 'log'], roles: ['reviewer', 'lead_reviewer', 'code_reviewer'] },
      { type: 'knowledge', artifactTypes: ['image', 'video', 'audio', 'other'], roles: ['reviewer', 'lead_reviewer', 'knowledge_reviewer'] },
    ]
    const insert = this.db.prepare(`
      INSERT INTO review_policies(id, policy_type, version, rules_json, active, created_at, updated_at)
      VALUES (?, ?, '1.0.0', ?, 1, ?, ?)
      ON CONFLICT(policy_type, version) DO NOTHING
    `)
    for (const policy of policies) {
      insert.run(`policy:${policy.type}:1.0.0`, policy.type, JSON.stringify({
        artifact_types: policy.artifactTypes,
        reviewer_roles: policy.roles,
        require_evidence: true,
        require_healthy_audit: true,
        require_version: true,
        require_available_sources: true,
      }), timestamp, timestamp)
    }
  }

  private backfillArtifactVersions(): void {
    const rows = this.db.prepare(`
      SELECT a.id, a.sha256, a.size_bytes, a.created_at
      FROM artifacts a
      LEFT JOIN artifact_versions av ON av.artifact_id = a.id
      WHERE av.id IS NULL
      ORDER BY a.created_at ASC, a.id ASC
    `).all() as { id: string; sha256: string; size_bytes: number; created_at: string }[]
    if (rows.length === 0) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const insert = this.db.prepare(`
        INSERT INTO artifact_versions(id, artifact_id, version_number, sha256, size_bytes, created_at, change_note)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `)
      for (const row of rows) insert.run(`baseline:${row.id}:v1`, row.id, row.sha256, row.size_bytes, row.created_at, 'STEP-19 existing Artifact baseline')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private findProjectForTaskInput(input: TaskCreateInput): ProjectContext | undefined {
    const candidate = input.workspacePath ?? (['file', 'directory'].includes(input.inputType ?? '') ? input.inputValue : null)
    if (candidate === null || !path.isAbsolute(candidate)) return undefined
    return this.listProjectContexts()
      .sort((a, b) => b.rootPath.length - a.rootPath.length)
      .find(project => pathBelongsToRoot(candidate, project.rootPath))
  }

  private mapInputAsset(row: Record<string, unknown>): InputAsset {
    return {
      id: String(row.id),
      input_type: row.input_type as InputAssetType,
      display_name: String(row.display_name),
      original_path: row.original_path === null ? null : String(row.original_path),
      staged_path: row.staged_path === null ? null : String(row.staged_path),
      access_mode: row.access_mode as InputAccessMode,
      source_mode: row.source_mode as InputSourceMode,
      mime_type: String(row.mime_type),
      size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
      sha256: row.sha256 === null ? null : String(row.sha256),
      created_at: String(row.created_at),
      expires_at: row.expires_at === null ? null : String(row.expires_at),
      task_id: row.task_id === null ? null : String(row.task_id),
      project_id: row.project_id === null ? null : String(row.project_id),
      metadata: parseJson(String(row.metadata_json), {}),
    }
  }

  private mapTemporaryInputGrant(row: Record<string, unknown>): TemporaryInputGrant {
    return {
      grant_id: String(row.grant_id),
      input_asset_id: String(row.input_asset_id),
      selected_path: String(row.selected_path),
      kind: row.kind as 'file' | 'directory',
      scope: row.scope as InputGrantScope,
      created_at: String(row.created_at),
      expires_at: String(row.expires_at),
      task_id: row.task_id === null ? null : String(row.task_id),
      status: row.status as TemporaryInputGrant['status'],
      source_mode: 'native_picker',
    }
  }

  private mapLearningDocument(row: Record<string, unknown>): LearningDocumentRecord {
    const content = parseJson<Record<string, unknown>>(String(row.content_json), {})
    return {
      id: String(row.id), task_id: String(row.task_id), project_id: String(row.project_id),
      source_type: String(row.source_type), source_title: String(row.source_title), source_reference: String(row.source_reference),
      document_title: String(row.document_title), document_mode: row.document_mode as LearningDocumentRecord['document_mode'],
      detail_level: row.detail_level as LearningDocumentRecord['detail_level'], summary: String(row.summary),
      sections: Array.isArray(content.sections) ? content.sections as LearningDocumentRecord['sections'] : [],
      learning_goals: Array.isArray(content.learning_goals) ? content.learning_goals as string[] : [],
      key_points: Array.isArray(content.key_points) ? content.key_points as string[] : [],
      terms: Array.isArray(content.terms) ? content.terms as LearningDocumentRecord['terms'] : [],
      formulas: Array.isArray(content.formulas) ? content.formulas as string[] : [],
      code_examples: Array.isArray(content.code_examples) ? content.code_examples as string[] : [],
      confusions: Array.isArray(content.confusions) ? content.confusions as string[] : [],
      review_questions: Array.isArray(content.review_questions) ? content.review_questions as string[] : [],
      learning_tips: Array.isArray(content.learning_tips) ? content.learning_tips as string[] : [],
      references: Array.isArray(content.references) ? content.references as LearningDocumentRecord['references'] : [],
      json_artifact_id: row.json_artifact_id === null ? null : String(row.json_artifact_id),
      docx_artifact_id: row.docx_artifact_id === null ? null : String(row.docx_artifact_id),
      supersedes_document_id: row.supersedes_document_id === null ? null : String(row.supersedes_document_id),
      created_at: String(row.created_at),
    }
  }

  private mapTask(row: Record<string, unknown>): WorkbenchTask {
    return {
      id: String(row.id),
      projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
      templateId: row.template_id as WorkbenchTask['templateId'],
      title: String(row.title),
      inputType: String(row.input_type),
      inputValue: String(row.input_value),
      workspacePath: row.workspace_path === null ? null : String(row.workspace_path),
      projectName: row.project_name === null ? null : String(row.project_name),
      profile: String(row.profile),
      permissionMode: 'read-only',
      status: row.status as TaskStatus,
      taskOrigin: row.task_origin === 'user' || row.task_origin === 'validation' || row.task_origin === 'system' ? row.task_origin : 'legacy',
      hiddenAt: row.hidden_at === null || row.hidden_at === undefined ? null : String(row.hidden_at),
      createdAt: String(row.created_at),
      startedAt: row.started_at === null ? null : String(row.started_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
      harnessSessionId: row.harness_session_id === null ? null : String(row.harness_session_id),
      runtimePid: row.runtime_pid === null ? null : Number(row.runtime_pid),
      resultText: row.result_text === null ? null : String(row.result_text),
      errorCode: row.error_code === null ? null : String(row.error_code),
      errorMessage: row.error_message === null ? null : String(row.error_message),
      artifactIndex: parseJson(String(row.artifact_index_json), []),
      citationIndex: parseJson(String(row.citation_index_json), []),
      metadata: parseJson(String(row.metadata_json), {}),
    }
  }

  private mapTaskRuntime(row: Record<string, unknown>): TaskRuntimeState {
    return {
      task_id: String(row.task_id),
      task_type: String(row.task_type),
      current_stage: row.current_stage as TaskRuntimeStage,
      progress: Number(row.progress),
      status: row.status as TaskRuntimeStatus,
      message: String(row.message),
      started_at: row.started_at === null ? null : String(row.started_at),
      finished_at: row.finished_at === null ? null : String(row.finished_at),
      active_model: row.active_model === null ? null : String(row.active_model),
      updated_at: String(row.updated_at),
    }
  }

  private mapKnowledgeIngestionSource(row: Record<string, unknown>): KnowledgeIngestionRecord {
    return {
      id: String(row.id),
      task_id: String(row.task_id),
      project_id: row.project_id === null ? null : String(row.project_id),
      source_type: row.source_type as KnowledgeSourceType,
      source_reference: String(row.source_reference),
      display_name: String(row.display_name),
      pipeline: row.pipeline as KnowledgeIngestionPipeline,
      metadata: parseJson(String(row.metadata_json), {}),
      created_at: String(row.created_at),
    }
  }

  private mapUnifiedDocument(row: Record<string, unknown>): UnifiedDocumentRecord {
    return {
      id: String(row.id), task_id: String(row.task_id), project_id: String(row.project_id),
      source_type: row.source_type as UnifiedDocumentRecord['source_type'], source_url: String(row.source_url),
      canonical_url: String(row.canonical_url), title: String(row.title),
      author: row.author === null ? null : String(row.author), site_name: row.site_name === null ? null : String(row.site_name),
      description: row.description === null ? null : String(row.description), language: row.language === null ? null : String(row.language),
      content_type: String(row.content_type), content: String(row.content),
      sections: parseJson(String(row.sections_json), []), code_blocks: parseJson(String(row.code_blocks_json), []),
      links: parseJson(String(row.links_json), []), metadata: parseJson(String(row.metadata_json), {}),
      acquired_at: String(row.acquired_at), content_sha256: String(row.content_sha256),
    }
  }

  private mapArtifact(row: Record<string, unknown>): ArtifactRecord {
    const id = String(row.id)
    const lineage = this.getArtifactLineageIds(id)
    const versionCount = this.listArtifactVersions(lineage).length
    return {
      id,
      project_id: String(row.project_id),
      task_id: row.task_id === null ? null : String(row.task_id),
      artifact_type: row.artifact_type as ArtifactRecord['artifact_type'],
      name: String(row.name),
      relative_path: String(row.relative_path),
      absolute_path: String(row.absolute_path),
      mime_type: String(row.mime_type),
      size_bytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      status: row.status as ArtifactStatus,
      version_count: versionCount,
      created_at: String(row.created_at),
      metadata: parseJson(String(row.metadata_json), {}),
    }
  }

  private mapArtifactVersion(row: Record<string, unknown>): ArtifactVersionRecord {
    return {
      id: String(row.id),
      artifact_id: String(row.artifact_id),
      version_number: Number(row.version_number),
      sha256: String(row.sha256),
      size_bytes: Number(row.size_bytes),
      created_at: String(row.created_at),
      change_note: String(row.change_note),
    }
  }

  private mapArtifactVersionLink(row: Record<string, unknown>): ArtifactVersionLinkRecord {
    return {
      id: String(row.id),
      old_artifact_id: String(row.old_artifact_id),
      new_artifact_id: String(row.new_artifact_id),
      relation: 'supersedes',
      created_at: String(row.created_at),
    }
  }

  private mapArtifactEvidenceLink(row: Record<string, unknown>): ArtifactEvidenceLinkRecord {
    return {
      id: String(row.id),
      artifact_id: String(row.artifact_id),
      source_type: row.source_type as ArtifactEvidenceSourceType,
      source_id: String(row.source_id),
      relation_type: row.relation_type as ArtifactEvidenceRelationType,
      created_at: String(row.created_at),
      metadata: parseJson(String(row.metadata_json), {}),
    }
  }

  private mapProvenanceAuditRecord(row: Record<string, unknown>): ProvenanceAuditRecord {
    return {
      id: String(row.id),
      artifact_id: String(row.artifact_id),
      status: row.status as EvidenceAuditStatus,
      issues: parseJson(String(row.issues_json), []) as EvidenceAuditIssue[],
      created_at: String(row.created_at),
    }
  }

  private mapReviewDecision(row: Record<string, unknown>): ReviewDecisionRecord {
    return {
      id: String(row.id),
      artifact_id: String(row.artifact_id),
      decision: row.decision as ReviewDecision,
      reviewer: String(row.reviewer),
      reviewer_id: row.reviewer_id === null || row.reviewer_id === undefined ? null : String(row.reviewer_id),
      artifact_hash: row.artifact_hash === null || row.artifact_hash === undefined ? null : String(row.artifact_hash),
      evidence_hash: row.evidence_hash === null || row.evidence_hash === undefined ? null : String(row.evidence_hash),
      policy_type: row.policy_type === null || row.policy_type === undefined ? null : row.policy_type as ReviewPolicyType,
      policy_version: row.policy_version === null || row.policy_version === undefined ? null : String(row.policy_version),
      recheck_of_review_id: row.recheck_of_review_id === null || row.recheck_of_review_id === undefined ? null : String(row.recheck_of_review_id),
      note: String(row.note),
      created_at: String(row.created_at),
    }
  }

  private mapReviewerProfile(row: Record<string, unknown>): ReviewerProfile {
    return {
      id: String(row.id),
      name: String(row.name),
      role: row.role as ReviewerRole,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }
  }

  private mapReviewPolicy(row: Record<string, unknown>): ReviewPolicy {
    return {
      id: String(row.id),
      policy_type: row.policy_type as ReviewPolicyType,
      version: String(row.version),
      rules: parseJson(String(row.rules_json), {}) as ReviewPolicy['rules'],
      active: Number(row.active) === 1,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }
  }

  private mapReviewInvalidation(row: Record<string, unknown>): ReviewInvalidation {
    return {
      id: String(row.id),
      review_decision_id: String(row.review_decision_id),
      artifact_id: String(row.artifact_id),
      reason: row.reason as ReviewInvalidationReason,
      previous_hash: String(row.previous_hash),
      current_hash: String(row.current_hash),
      created_at: String(row.created_at),
    }
  }

  private mapReviewSnapshotDetail(row: Record<string, unknown>): ReviewSnapshotDetail {
    return {
      review_decision_id: String(row.review_decision_id),
      artifact_snapshot_path: row.artifact_snapshot_path === null ? null : String(row.artifact_snapshot_path),
      artifact_snapshot_sha256: row.artifact_snapshot_sha256 === null ? null : String(row.artifact_snapshot_sha256),
      artifact_snapshot_size: row.artifact_snapshot_size === null ? null : Number(row.artifact_snapshot_size),
      artifact_snapshot_kind: row.artifact_snapshot_kind === null ? null : row.artifact_snapshot_kind as ReviewSnapshotDetail['artifact_snapshot_kind'],
      evidence_snapshot: parseJson(String(row.evidence_snapshot_json), []),
      created_at: String(row.created_at),
    }
  }

  private mapProjectContext(row: Record<string, unknown>): ProjectContext {
    return {
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      description: String(row.description),
      projectType: row.project_type as ProjectType,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastScanAt: row.last_scan_at === null ? null : String(row.last_scan_at),
    }
  }

  private mapProjectAssetSnapshot(row: Record<string, unknown>): ProjectAssetSnapshot {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      canonicalRoot: String(row.canonical_root),
      fileCount: Number(row.file_count),
      directoryCount: Number(row.directory_count),
      totalBytes: Number(row.total_bytes),
      extensionDistribution: parseJson(String(row.extension_distribution_json), []),
      recentFiles: parseJson(String(row.recent_files_json), []),
      largeFiles: parseJson(String(row.large_files_json), []),
      skippedCount: Number(row.skipped_count),
      durationMs: Number(row.duration_ms),
      detectedSignals: parseJson(String(row.detected_signals_json), {
        hasSrc: false, hasDocs: false, hasReadme: false, hasPackageJson: false, hasPyprojectToml: false, hasPdf: false,
      }),
      createdAt: String(row.created_at),
    }
  }

  private mapProjectMemoryReference(row: Record<string, unknown>): ProjectMemoryReference {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      memoryRole: row.memory_role as ProjectMemoryReference['memoryRole'],
      memoryProjectName: String(row.memory_project_name),
      memoryEntityType: String(row.memory_entity_type),
      memoryEntityId: String(row.memory_entity_id),
      createdAt: String(row.created_at),
    }
  }
}
