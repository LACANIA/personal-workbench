import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { URL } from 'node:url'
import type { ArtifactEvidenceCreateInput, ArtifactRegisterInput, ArtifactStatus, ArtifactType, DatabaseRole, KnowledgeCardReviewDecision, KnowledgeIngestionInput, LearningDocumentGenerateInput, ProjectRegisterInput, TaskCreateInput, VideoCreateInput, VideoSearchInput } from '../../shared/contracts/index.ts'
import { ArtifactEvidenceService } from './artifacts/evidence-service.ts'
import { EvidenceAuditService } from './artifacts/evidence-audit-service.ts'
import { EvidenceHealthService } from './artifacts/evidence-health-service.ts'
import { ArtifactIntelligenceService } from './artifacts/intelligence-service.ts'
import { ProvenanceExportService } from './artifacts/provenance-export-service.ts'
import { ProvenanceGraphService } from './artifacts/provenance-graph-service.ts'
import { ReleaseAuditService } from './artifacts/release-audit-service.ts'
import { ReviewQueueService } from './artifacts/review-queue-service.ts'
import { ReviewPolicyService } from './artifacts/review-policy-service.ts'
import { ArtifactService } from './artifacts/service.ts'
import { LOCAL_CONFIG, TEMPLATES, PATHS, PROFILE_ALLOWLIST } from './config.ts'
import { saveLocalConfig } from './portable-config.ts'
import { WorkbenchDatabase } from './database.ts'
import { BackupManager } from './distribution/backup-manager.ts'
import { FirstRunService } from './distribution/first-run-service.ts'
import { DistributionStatusService } from './distribution/status-service.ts'
import { collectHealth, getLegacyReuseStatus } from './health/checks.ts'
import { bridgeRequest, listProjects, readMemoryStatus, type MemoryRole } from './memory/service.ts'
import { UniversalInputService } from './input/service.ts'
import { KnowledgeIngestionService } from './ingestion/service.ts'
import { LearningDocumentService } from './learning/service.ts'
import { FileOrganizerService } from './organizer/service.ts'
import { ProjectContextService } from './projects/service.ts'
import { TaskManager } from './tasks/manager.ts'
import { VideoKnowledgeRepository } from './video/repository.ts'
import { VideoKnowledgeService } from './video/service.ts'

const HOST = '127.0.0.1'
const TOKEN = randomBytes(32).toString('base64url')
const DESKTOP_BRIDGE_TOKEN = process.env.PERSONAL_WORKBENCH_DESKTOP_BRIDGE_TOKEN ?? ''
const database = new WorkbenchDatabase()
const artifactEvidence = new ArtifactEvidenceService(database)
const artifacts = new ArtifactService(database, artifactEvidence)
const artifactIntelligence = new ArtifactIntelligenceService(database, artifacts)
const provenanceGraph = new ProvenanceGraphService(database, artifactEvidence)
const evidenceAudit = new EvidenceAuditService(database, artifacts, artifactEvidence)
const reviewPolicy = new ReviewPolicyService(database, artifacts, artifactEvidence, evidenceAudit)
const releaseAudit = new ReleaseAuditService(artifacts, artifactEvidence, evidenceAudit, reviewPolicy)
const evidenceHealth = new EvidenceHealthService(database, evidenceAudit, releaseAudit)
const reviewQueue = new ReviewQueueService(database, artifacts, artifactEvidence, evidenceAudit, releaseAudit, reviewPolicy)
const provenanceExport = new ProvenanceExportService(database, artifacts)
const inputs = new UniversalInputService(database)
const tasks = new TaskManager(database, artifacts, inputs)
const projects = new ProjectContextService(database, inputs)
await projects.ensurePersonalInbox()
const videoRepository = new VideoKnowledgeRepository(database)
const video = new VideoKnowledgeService(database, videoRepository, tasks, artifacts, artifactEvidence, releaseAudit)
const learningDocuments = new LearningDocumentService(database, tasks, artifacts, videoRepository)
const ingestion = new KnowledgeIngestionService(database, tasks, video, artifacts, learningDocuments)
const backups = new BackupManager()
const firstRun = new FirstRunService()
const distribution = new DistributionStatusService(backups, firstRun, video.media)
const organizer = new FileOrganizerService(database, tasks, artifacts)
let boundPort = 0

function isLoopback(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(data))
}

function ok(response: ServerResponse, data: unknown, status = 200): void {
  json(response, status, { ok: true, data })
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
  json(response, status, { ok: false, error: { code, message } })
}

function downloadableJson(response: ServerResponse, filename: string, data: unknown): void {
  response.statusCode = 200
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(data, null, 2))
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
}

function authenticate(request: IncomingMessage): boolean {
  return request.headers['x-workbench-token'] === TOKEN
}

function authenticateDesktopBridge(request: IncomingMessage): boolean {
  const supplied = request.headers['x-desktop-bridge-token']
  if (DESKTOP_BRIDGE_TOKEN.length < 32 || typeof supplied !== 'string') return false
  const expectedBuffer = Buffer.from(DESKTOP_BRIDGE_TOKEN)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function validateOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  return origin === `http://${HOST}:${boundPort}`
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) throw new Error('REQUEST_BODY_TOO_LARGE')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_JSON_BODY')
  return parsed as Record<string, unknown>
}

async function binaryBody(request: IncomingMessage, maximumBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maximumBytes) throw new Error('INPUT_STAGE_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function memoryRole(url: URL): MemoryRole {
  return url.searchParams.get('role') === 'test' ? 'test' : 'production'
}

async function apiModels(): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(new URL('/api/tags', `${PATHS.ollamaEndpoint}/`), { signal: AbortSignal.timeout(3000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const value = await response.json() as { models?: Record<string, unknown>[] }
    const selected = new Set([LOCAL_CONFIG.model_name, LOCAL_CONFIG.embedding_model, 'qwen2.5-coder:7b'])
    return {
      endpoint: PATHS.ollamaEndpoint, status: 'running',
      models: (value.models ?? []).filter(item => selected.has(String(item.name ?? item.model))).map(item => ({
        id: item.name ?? item.model, size: item.size, modifiedAt: item.modified_at,
        role: item.name === LOCAL_CONFIG.model_name ? '通用工具与研究任务' : item.name === LOCAL_CONFIG.embedding_model ? '本地检索' : '代码与纯文本专项',
      })),
    }
  } catch (error) {
    return { endpoint: PATHS.ollamaEndpoint, status: 'unavailable', models: [], message: error instanceof Error ? error.message : String(error) }
  }
}

async function serveStatic(requestPath: string, response: ServerResponse): Promise<void> {
  const normalized = requestPath === '/' ? '/index.html' : requestPath
  const candidate = path.resolve(PATHS.webDist, `.${normalized}`)
  if (!candidate.toLowerCase().startsWith(PATHS.webDist.toLowerCase() + path.sep)) {
    fail(response, 404, 'NOT_FOUND', '页面不存在。')
    return
  }
  let filePath = candidate
  try {
    if (!(await stat(filePath)).isFile()) throw new Error('not-file')
  } catch {
    filePath = path.join(PATHS.webDist, 'index.html')
  }
  const extensions: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  }
  response.statusCode = 200
  response.setHeader('Content-Type', extensions[path.extname(filePath)] ?? 'application/octet-stream')
  if (filePath.endsWith('index.html')) response.setHeader('Cache-Control', 'no-store')
  else response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  createReadStream(filePath).pipe(response)
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setSecurityHeaders(response)
  if (!isLoopback(request.socket.remoteAddress)) {
    fail(response, 403, 'LOOPBACK_ONLY', '服务仅接受本机回环连接。')
    return
  }
  const url = new URL(request.url ?? '/', `http://${HOST}:${boundPort}`)
  if (!url.pathname.startsWith('/api/')) {
    await serveStatic(url.pathname, response)
    return
  }
  if (!validateOrigin(request)) {
    fail(response, 403, 'ORIGIN_DENIED', '请求来源不在允许范围。')
    return
  }
  response.setHeader('Access-Control-Allow-Origin', `http://${HOST}:${boundPort}`)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Workbench-Token, X-Input-File-Name')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return }
  if (!authenticate(request)) {
    fail(response, 401, 'TOKEN_REQUIRED', '请求缺少有效的本机会话令牌。')
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/health') { ok(response, await collectHealth()); return }
  if (request.method === 'GET' && url.pathname === '/api/runtime/monitor') { ok(response, await tasks.monitor()); return }
  if (request.method === 'GET' && url.pathname === '/api/input/capabilities') { ok(response, inputs.capabilities()); return }
  if (request.method === 'POST' && (url.pathname === '/api/input/select-file' || url.pathname === '/api/input/select-directory')) {
    const payload = await body(request)
    ok(response, await inputs.select(url.pathname.endsWith('select-file') ? 'file' : 'directory', payload.user_action === true), 201)
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/input/register-desktop-selection') {
    if (!authenticateDesktopBridge(request)) throw new Error('DESKTOP_BRIDGE_DENIED')
    const payload = await body(request)
    if ((payload.kind !== 'file' && payload.kind !== 'directory') || typeof payload.path !== 'string') throw new Error('INPUT_PICKER_INVALID_RESPONSE')
    ok(response, await inputs.registerDesktopSelection(payload.kind, payload.path), 201)
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/input/stage') {
    const encodedName = request.headers['x-input-file-name']
    if (typeof encodedName !== 'string' || encodedName.length === 0) throw new Error('INPUT_FILENAME_REQUIRED')
    let fileName: string
    try { fileName = decodeURIComponent(encodedName) } catch { throw new Error('INPUT_FILENAME_DENIED') }
    ok(response, await inputs.stage(fileName, await binaryBody(request), request.headers['content-type']), 201)
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/organizer/scan') { ok(response, await organizer.scan(await body(request) as { input_asset_id: string; mode?: 'light'|'smart'|'project'; optimize_names?: boolean }), 201); return }
  if (request.method === 'GET' && url.pathname === '/api/organizer/history') { ok(response, organizer.listHistory(Number(url.searchParams.get('limit') ?? 100))); return }
  if (request.method === 'GET' && url.pathname === '/api/organizer/rules') { ok(response, organizer.listRules()); return }
  if (request.method === 'POST' && url.pathname === '/api/organizer/rules') { const payload=await body(request); ok(response, organizer.createRule({pattern:typeof payload.pattern==='string'?payload.pattern:'',destination_relative_path:typeof payload.destination_relative_path==='string'?payload.destination_relative_path:''}),201); return }
  const organizerMatch = url.pathname.match(/^\/api\/organizer\/plans\/([^/]+)(?:\/(approve|execute|undo|edit|add-pending))?$/u)
  if (organizerMatch !== null) {
    const id = decodeURIComponent(organizerMatch[1]!); const action = organizerMatch[2]
    if (request.method === 'GET' && action === undefined) { ok(response, organizer.get(id)); return }
    if (request.method === 'POST' && action === 'approve') { const payload=await body(request); ok(response, organizer.approve(id,Array.isArray(payload.operation_ids)?payload.operation_ids.filter((value):value is string=>typeof value==='string'):undefined)); return }
    if (request.method === 'POST' && action === 'execute') { ok(response, await organizer.execute(id)); return }
    if (request.method === 'POST' && action === 'undo') { const payload=await body(request); ok(response, await organizer.undo(id,typeof payload.input_asset_id==='string'?payload.input_asset_id:undefined)); return }
    if (request.method === 'POST' && action === 'edit') { const payload=await body(request); if(typeof payload.operation_id!=='string'||typeof payload.destination_relative_path!=='string')throw new Error('ORGANIZATION_EDIT_INPUT_REQUIRED'); ok(response,organizer.updateOperationDestination(id,payload.operation_id,payload.destination_relative_path)); return }
    if (request.method === 'POST' && action === 'add-pending') { const payload=await body(request); const items=Array.isArray(payload.items)?payload.items.filter((item):item is {source_relative_path:string;destination_relative_path:string}=>item!==null&&typeof item==='object'&&typeof (item as Record<string,unknown>).source_relative_path==='string'&&typeof (item as Record<string,unknown>).destination_relative_path==='string'):[]; ok(response,await organizer.addPendingOperations(id,items)); return }
  }
  const inputAssetMatch = url.pathname.match(/^\/api\/input\/assets\/([^/]+)$/u)
  if (inputAssetMatch !== null) {
    const id = decodeURIComponent(inputAssetMatch[1]!)
    if (request.method === 'GET') { ok(response, inputs.get(id)); return }
    if (request.method === 'DELETE') { ok(response, await inputs.deleteUnused(id)); return }
  }
  if (request.method === 'GET' && url.pathname === '/api/capabilities') {
    const step14 = readMemoryStatus('test')
    ok(response, { templates: TEMPLATES, step14Available: step14.userVersion === 4 && (step14.ftsState as { status?: string } | null)?.status === 'valid' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/models') { ok(response, await apiModels()); return }
  if (request.method === 'GET' && url.pathname === '/api/config') { ok(response, LOCAL_CONFIG); return }
  if (request.method === 'POST' && url.pathname === '/api/config/interface-mode') {
    const payload = await body(request)
    if (payload.interface_mode !== 'consumer' && payload.interface_mode !== 'advanced') throw new Error('INTERFACE_MODE_INVALID')
    ok(response, saveLocalConfig(PATHS.localConfig, { ...LOCAL_CONFIG, interface_mode: payload.interface_mode }))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/first-run') { ok(response, await firstRun.status()); return }
  if (request.method === 'POST' && url.pathname === '/api/first-run/smoke') { ok(response, await firstRun.smoke()); return }
  if (request.method === 'POST' && url.pathname === '/api/first-run/complete') {
    const payload = await body(request)
    ok(response, { config: firstRun.complete(payload), restart_required: true })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/distribution/status') { ok(response, await distribution.status()); return }
  if (request.method === 'GET' && url.pathname === '/api/backups') { ok(response, await backups.list()); return }
  if (request.method === 'POST' && url.pathname === '/api/backups') { ok(response, await backups.create(), 201); return }
  const backupVerifyMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/verify$/u)
  if (request.method === 'POST' && backupVerifyMatch !== null) { ok(response, await backups.verify(decodeURIComponent(backupVerifyMatch[1]!))); return }
  if (request.method === 'GET' && url.pathname === '/api/profiles') {
    ok(response, Object.entries(PROFILE_ALLOWLIST).map(([id, value]) => ({ id, model: value.model, databaseRole: value.databaseRole, permissionMode: 'read-only' })))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/reviewers') { ok(response, reviewPolicy.listReviewers()); return }
  if (request.method === 'POST' && url.pathname === '/api/reviewers') {
    const payload = await body(request)
    ok(response, reviewPolicy.createReviewer({ name: payload.name, role: payload.role }), 201)
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/review-policies') { ok(response, reviewPolicy.listPolicies()); return }
  if (request.method === 'GET' && url.pathname === '/api/workspaces') {
    const policy = JSON.parse((await readFile(PATHS.policy, 'utf8')).replace(/^\uFEFF/u, '')) as Record<string, unknown>
    ok(response, { allowedRoots: policy.allowedRoots ?? [], recent: tasks.list(100).map(item => item.workspacePath).filter((item, index, all) => item !== null && all.indexOf(item) === index).slice(0, 8) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/projects/context') { ok(response, projects.list()); return }
  if (request.method === 'POST' && url.pathname === '/api/projects/register') {
    const payload = await body(request)
    const input: ProjectRegisterInput = {
      rootPath: (payload.rootPath ?? payload.root_path) as string,
      ...(payload.name === undefined ? {} : { name: payload.name as string }),
      ...(payload.description === undefined ? {} : { description: payload.description as string }),
      ...(payload.inputAssetId === undefined && payload.input_asset_id === undefined ? {} : { inputAssetId: (payload.inputAssetId ?? payload.input_asset_id) as string }),
    }
    ok(response, await projects.register(input), 201)
    return
  }
  const projectArtifactsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/artifacts$/u)
  if (request.method === 'GET' && projectArtifactsMatch !== null) {
    const projectId = decodeURIComponent(projectArtifactsMatch[1]!)
    projects.detail(projectId)
    const artifactType = url.searchParams.get('artifact_type') ?? undefined
    const artifactStatus = url.searchParams.get('status') ?? undefined
    ok(response, artifacts.query({
      project_id: projectId,
      ...(artifactType === undefined ? {} : { artifact_type: artifactType as ArtifactType }),
      ...(artifactStatus === undefined ? {} : { status: artifactStatus as ArtifactStatus }),
      limit: Number(url.searchParams.get('limit') ?? 100),
    }))
    return
  }
  const projectProvenanceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/(provenance|audit|evidence-health|reviews|review-summary|review-history)$/u)
  if (request.method === 'GET' && projectProvenanceMatch !== null) {
    const projectId = decodeURIComponent(projectProvenanceMatch[1]!)
    projects.detail(projectId)
    const action = projectProvenanceMatch[2]
    const isProvenance = projectProvenanceMatch[2] === 'provenance'
    ok(response, isProvenance
      ? provenanceGraph.project(projectId)
      : action === 'audit'
        ? evidenceAudit.auditProject(projectId)
        : action === 'evidence-health'
          ? evidenceHealth.getProjectEvidenceHealth(projectId)
          : action === 'reviews' ? reviewQueue.getPendingReviews(projectId)
            : action === 'review-history' ? reviewQueue.changes.projectHistory(projectId)
              : reviewQueue.getReviewSummary(projectId))
    return
  }
  const projectContextMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(scan|history|timeline|memory-link))?$/u)
  if (projectContextMatch !== null) {
    const id = decodeURIComponent(projectContextMatch[1]!)
    const action = projectContextMatch[2]
    if (request.method === 'GET' && action === undefined) { ok(response, projects.detail(id)); return }
    if (request.method === 'POST' && action === 'scan') { ok(response, await projects.scan(id)); return }
    if (request.method === 'GET' && action === 'history') { ok(response, projects.history(id, Number(url.searchParams.get('limit') ?? 100))); return }
    if (request.method === 'GET' && action === 'timeline') { ok(response, projects.timeline(id, Number(url.searchParams.get('limit') ?? 100))); return }
    if ((request.method === 'POST' || request.method === 'DELETE') && action === 'memory-link') {
      const payload = await body(request)
      const memoryProjectId = payload.memory_project_id
      const roleValue = payload.memory_role
      if (roleValue !== undefined && roleValue !== 'production' && roleValue !== 'test') throw new Error('INVALID_MEMORY_ROLE')
      const role = roleValue as DatabaseRole | undefined
      const result = request.method === 'POST'
        ? projects.linkMemory(id, memoryProjectId as string, role)
        : projects.unlinkMemory(id, memoryProjectId as string, role)
      ok(response, result)
      return
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/projects') { ok(response, { role: memoryRole(url), projects: listProjects(memoryRole(url)) }); return }
  if (request.method === 'GET' && url.pathname === '/api/memory/status') { ok(response, readMemoryStatus(memoryRole(url))); return }
  if (request.method === 'GET' && url.pathname === '/api/document-search/status') {
    const status = readMemoryStatus(memoryRole(url))
    ok(response, { role: status.role, schemaVersion: status.userVersion, chunkCount: (status.counts as Record<string, number>).document_chunks, ftsCount: status.ftsCount, ftsState: status.ftsState })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/sessions/recent') {
    ok(response, tasks.list(100).filter(item => item.harnessSessionId !== null).slice(0, 20).map(item => ({ taskId: item.id, sessionId: item.harnessSessionId, title: item.title, status: item.status, completedAt: item.completedAt })))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/video2skill/reuse-status') { ok(response, await getLegacyReuseStatus()); return }
  if (request.method === 'GET' && url.pathname === '/api/video/capabilities') { ok(response, await video.media.diagnose()); return }
  if (request.method === 'POST' && url.pathname === '/api/video/runtime/recheck') { ok(response, await video.media.diagnose()); return }
  if (request.method === 'GET' && url.pathname === '/api/video/asr/diagnostics') { ok(response, await video.media.asrDiagnostics.diagnose()); return }
  if (request.method === 'POST' && url.pathname === '/api/video/asr/diagnostics/recheck') { ok(response, await video.media.asrDiagnostics.diagnose()); return }
  if (request.method === 'GET' && url.pathname === '/api/retrieval/diagnostics') { ok(response, await video.retrieval.diagnostics()); return }
  if (request.method === 'GET' && url.pathname === '/api/knowledge/diagnostics') { ok(response, await video.knowledge.diagnostics()); return }
  if (request.method === 'POST' && url.pathname === '/api/knowledge/detect') {
    ok(response, ingestion.detect(await body(request) as KnowledgeIngestionInput)); return
  }
  if (request.method === 'POST' && url.pathname === '/api/knowledge/ingest') {
    ok(response, await ingestion.ingest(await body(request) as KnowledgeIngestionInput), 201); return
  }
  if (request.method === 'GET' && url.pathname === '/api/knowledge/ingestions') {
    ok(response, ingestion.list(url.searchParams.get('project_id') ?? undefined)); return
  }
  if (request.method === 'GET' && url.pathname === '/api/knowledge/adapters/health') {
    ok(response, await ingestion.adapterHealth()); return
  }
  if (request.method === 'POST' && url.pathname === '/api/documents/search') {
    const payload = await body(request)
    ok(response, await ingestion.documentSearch.search({
      query: payload.query,
      ...(typeof payload.document_id === 'string' ? { document_id: payload.document_id } : {}),
      ...(typeof payload.project_id === 'string' ? { project_id: payload.project_id } : {}),
      ...(payload.top_k === undefined ? {} : { top_k: payload.top_k }),
    }))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/documents/ask') {
    const payload = await body(request)
    if (typeof payload.document_id !== 'string' || payload.document_id.length === 0) throw new Error('DOCUMENT_ANSWER_DOCUMENT_ID_REQUIRED')
    ok(response, await ingestion.documentSearch.ask({
      query: payload.query, document_id: payload.document_id,
      ...(typeof payload.project_id === 'string' ? { project_id: payload.project_id } : {}),
      ...(payload.top_k === undefined ? {} : { top_k: payload.top_k }),
    }))
    return
  }
  const ingestionMatch = url.pathname.match(/^\/api\/knowledge\/ingestions\/([^/]+)$/u)
  if (request.method === 'GET' && ingestionMatch !== null) {
    ok(response, ingestion.get(decodeURIComponent(ingestionMatch[1]!))); return
  }
  const ingestionDocumentMatch = url.pathname.match(/^\/api\/knowledge\/ingestions\/([^/]+)\/document$/u)
  if (request.method === 'GET' && ingestionDocumentMatch !== null) {
    const document = ingestion.documentForIngestion(decodeURIComponent(ingestionDocumentMatch[1]!))
    if (document === undefined) { fail(response, 404, 'UNIFIED_DOCUMENT_NOT_FOUND', '当前来源尚未形成可查看的统一文档。'); return }
    ok(response, document); return
  }
  if (request.method === 'GET' && url.pathname === '/api/knowledge/review-samples') {
    ok(response, video.knowledge.reviewSamples(Number(url.searchParams.get('limit') ?? 10))); return
  }
  if (request.method === 'GET' && url.pathname === '/api/knowledge/benchmark') {
    ok(response, video.repository.cards.latestBenchmark()); return
  }
  if (request.method === 'GET' && url.pathname === '/api/learning-documents') {
    const taskId = url.searchParams.get('task_id')
    if (taskId === null || taskId.length === 0) throw new Error('LEARNING_DOCUMENT_TASK_ID_REQUIRED')
    ok(response, learningDocuments.list(taskId)); return
  }
  if (request.method === 'POST' && url.pathname === '/api/learning-documents/generate') {
    ok(response, await learningDocuments.generate(await body(request) as unknown as LearningDocumentGenerateInput), 201); return
  }
  if (request.method === 'POST' && url.pathname === '/api/learning-documents/resume') {
    ok(response, await learningDocuments.resume(await body(request) as unknown as LearningDocumentGenerateInput), 201); return
  }
  const documentForTaskMatch = url.pathname.match(/^\/api\/documents\/task\/([^/]+)$/u)
  if (request.method === 'GET' && documentForTaskMatch !== null) {
    const taskId = decodeURIComponent(documentForTaskMatch[1]!)
    const document = database.getUnifiedDocumentByTask(taskId)
    if (document === undefined) { fail(response, 404, 'UNIFIED_DOCUMENT_NOT_FOUND', '当前任务尚未形成可查看的资料结构。'); return }
    ok(response, document); return
  }
  const learningDocumentMatch = url.pathname.match(/^\/api\/learning-documents\/([^/]+)(?:\/(regenerate))?$/u)
  if (learningDocumentMatch !== null) {
    const id = decodeURIComponent(learningDocumentMatch[1]!)
    const action = learningDocumentMatch[2]
    if (request.method === 'GET' && action === undefined) { ok(response, learningDocuments.get(id)); return }
    if (request.method === 'POST' && action === 'regenerate') {
      const existing = learningDocuments.get(id)
      const payload = await body(request)
      const mode = payload.document_mode === undefined ? existing.document_mode : payload.document_mode
      const detail = payload.detail_level === undefined ? existing.detail_level : payload.detail_level
      ok(response, await learningDocuments.generate({
        task_id: existing.task_id,
        ...(typeof mode === 'string' ? { document_mode: mode as NonNullable<LearningDocumentGenerateInput['document_mode']> } : {}),
        ...(typeof detail === 'string' ? { detail_level: detail as NonNullable<LearningDocumentGenerateInput['detail_level']> } : {}),
        supersedes_document_id: existing.id,
      }), 201)
      return
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/retrieval/index') {
    const payload = await body(request)
    ok(response, await video.retrieval.indexProject(typeof payload.project_id === 'string' ? payload.project_id : undefined)); return
  }
  if (request.method === 'GET' && url.pathname === '/api/media/temp') { ok(response, await video.cleanup.previewRuntimeTemp()); return }
  if (request.method === 'POST' && url.pathname === '/api/media/temp/cleanup') {
    const payload = await body(request)
    ok(response, await video.cleanup.cleanupRuntimeTemp(payload.confirm === true)); return
  }
  if (request.method === 'GET' && url.pathname === '/api/video/jobs') {
    const projectId = url.searchParams.get('project_id') ?? undefined
    ok(response, video.list(projectId)); return
  }
  if (request.method === 'POST' && url.pathname === '/api/video/jobs') {
    const payload = await body(request)
    ok(response, video.create(payload as unknown as VideoCreateInput), 201); return
  }
  if (request.method === 'POST' && url.pathname === '/api/video/search') {
    const payload = await body(request)
    ok(response, await video.search(payload as unknown as VideoSearchInput)); return
  }
  const knowledgeDocumentMatch = url.pathname.match(/^\/api\/video\/documents\/([^/]+)\/knowledge\/(extract|cards)$/u)
  if (knowledgeDocumentMatch !== null) {
    const documentId = decodeURIComponent(knowledgeDocumentMatch[1]!)
    const action = knowledgeDocumentMatch[2]
    if (request.method === 'GET' && action === 'cards') { ok(response, video.knowledge.list(documentId)); return }
    if (request.method === 'POST' && action === 'extract') {
      const payload = await body(request)
      const segmentIds = payload.segment_ids
      if (segmentIds !== undefined && (!Array.isArray(segmentIds) || !segmentIds.every(item => typeof item === 'string'))) {
        throw new Error('INVALID_KNOWLEDGE_SEGMENT_IDS')
      }
      ok(response, await video.knowledge.extractDocument(documentId, segmentIds === undefined ? {} : { segment_ids: segmentIds as string[] }), 201)
      return
    }
  }
  const knowledgeCardMatch = url.pathname.match(/^\/api\/knowledge\/cards\/([^/]+)(?:\/(review|regenerate))?$/u)
  if (knowledgeCardMatch !== null) {
    const cardId = decodeURIComponent(knowledgeCardMatch[1]!)
    const action = knowledgeCardMatch[2]
    if (request.method === 'GET' && action === undefined) { ok(response, video.knowledge.detail(cardId)); return }
    if (request.method === 'POST' && action === 'review') {
      const payload = await body(request)
      ok(response, video.knowledge.review(cardId, payload.decision as KnowledgeCardReviewDecision, payload.note)); return
    }
    if (request.method === 'POST' && action === 'regenerate') { ok(response, await video.knowledge.regenerate(cardId), 201); return }
  }
  const videoJobMatch = url.pathname.match(/^\/api\/video\/jobs\/([^/]+)(?:\/(start|publish|export))?$/u)
  if (videoJobMatch !== null) {
    const id = decodeURIComponent(videoJobMatch[1]!)
    const action = videoJobMatch[2]
    if (request.method === 'GET' && action === undefined) { ok(response, video.view(id)); return }
    if (request.method === 'POST' && action === 'start') { ok(response, video.start(id), 202); return }
    if (request.method === 'POST' && action === 'publish') { ok(response, video.publish(id)); return }
    if (request.method === 'GET' && action === 'export') { downloadableJson(response, 'video-knowledge-export.json', await video.export(id)); return }
  }
  if (request.method === 'GET' && url.pathname === '/api/artifacts') {
    const projectId = url.searchParams.get('project_id') ?? undefined
    const taskId = url.searchParams.get('task_id') ?? undefined
    const artifactType = url.searchParams.get('artifact_type') ?? undefined
    const artifactStatus = url.searchParams.get('status') ?? undefined
    ok(response, artifacts.query({
      ...(projectId === undefined ? {} : { project_id: projectId }),
      ...(taskId === undefined ? {} : { task_id: taskId }),
      ...(artifactType === undefined ? {} : { artifact_type: artifactType as ArtifactType }),
      ...(artifactStatus === undefined ? {} : { status: artifactStatus as ArtifactStatus }),
      limit: Number(url.searchParams.get('limit') ?? 100),
    }))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/artifacts/register') {
    const payload = await body(request)
    const input: ArtifactRegisterInput = {
      project_id: payload.project_id as string,
      file_path: (payload.file_path ?? payload.absolute_path) as string,
      ...(payload.task_id === undefined || payload.task_id === null ? {} : { task_id: payload.task_id as string }),
      ...(payload.artifact_type === undefined ? {} : { artifact_type: payload.artifact_type as ArtifactType }),
      ...(payload.name === undefined ? {} : { name: payload.name as string }),
      ...(payload.metadata === undefined ? {} : { metadata: payload.metadata as Record<string, unknown> }),
      ...(payload.supersedes_artifact_id === undefined ? {} : { supersedes_artifact_id: payload.supersedes_artifact_id as string }),
      ...(payload.change_note === undefined ? {} : { change_note: payload.change_note as string }),
      ...(payload.auto_link_task === undefined ? {} : { auto_link_task: payload.auto_link_task as boolean }),
      ...(payload.auto_link_session === undefined ? {} : { auto_link_session: payload.auto_link_session as boolean }),
      ...(payload.evidence === undefined ? {} : { evidence: payload.evidence as ArtifactEvidenceCreateInput[] }),
    }
    ok(response, await artifacts.register(input), 201)
    return
  }
  const evidenceSourceMatch = url.pathname.match(/^\/api\/evidence\/source\/([^/]+)\/([^/]+)$/u)
  if (request.method === 'GET' && evidenceSourceMatch !== null) {
    ok(response, artifactEvidence.bySource(decodeURIComponent(evidenceSourceMatch[1]!), decodeURIComponent(evidenceSourceMatch[2]!)))
    return
  }
  const evidenceMatch = url.pathname.match(/^\/api\/evidence\/([^/]+)$/u)
  if (request.method === 'DELETE' && evidenceMatch !== null) {
    ok(response, { evidence: artifactEvidence.delete(decodeURIComponent(evidenceMatch[1]!)), sources_deleted: false, artifacts_deleted: false })
    return
  }
  const provenanceExportMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/provenance\/export$/u)
  if (request.method === 'GET' && provenanceExportMatch !== null) {
    downloadableJson(response, 'artifact-provenance.json', provenanceExport.manifest(decodeURIComponent(provenanceExportMatch[1]!)))
    return
  }
  const artifactReviewHistoryMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/reviews\/history$/u)
  if (request.method === 'GET' && artifactReviewHistoryMatch !== null) {
    ok(response, reviewQueue.getReviewHistory(decodeURIComponent(artifactReviewHistoryMatch[1]!)))
    return
  }
  const artifactMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)(?:\/(preview|check|history|open-location|open-file|status|evidence|provenance|audit|review|review-signature|review-change|review-timeline|recheck))?$/u)
  if (artifactMatch !== null) {
    const id = decodeURIComponent(artifactMatch[1]!)
    const action = artifactMatch[2]
    if (request.method === 'GET' && action === 'preview') { ok(response, await artifactIntelligence.preview(id)); return }
    if (request.method === 'GET' && action === 'history') { ok(response, artifactIntelligence.history(id)); return }
    if (request.method === 'GET' && action === 'evidence') { ok(response, artifactEvidence.forArtifact(id)); return }
    if (request.method === 'GET' && action === 'review-signature') { ok(response, reviewPolicy.evaluateSignature(id)); return }
    if (request.method === 'GET' && action === 'review-change') { ok(response, reviewQueue.changes.report(id)); return }
    if (request.method === 'GET' && action === 'review-timeline') { ok(response, reviewQueue.changes.timeline(id)); return }
    if (request.method === 'GET' && action === 'provenance') {
      const depth = Number(url.searchParams.get('depth') ?? 1)
      ok(response, provenanceGraph.artifact(id, depth)); return
    }
    if (request.method === 'POST' && action === 'check') { ok(response, await artifactIntelligence.check(id)); return }
    if (request.method === 'POST' && action === 'audit') { ok(response, evidenceAudit.auditArtifact(id), 201); return }
    if (request.method === 'POST' && action === 'review') {
      const payload = await body(request)
      ok(response, reviewQueue.submitReview(id, {
        decision: payload.decision as 'pending' | 'approved' | 'rejected' | 'needs_revision',
        ...(payload.reviewer === undefined ? {} : { reviewer: payload.reviewer as string }),
        ...(payload.reviewer_id === undefined ? {} : { reviewer_id: payload.reviewer_id as string }),
        ...(payload.reviewer_role === undefined ? {} : { reviewer_role: payload.reviewer_role as string }),
        ...(payload.policy_type === undefined ? {} : { policy_type: payload.policy_type as string }),
        ...(payload.note === undefined ? {} : { note: payload.note as string }),
      }), 201)
      return
    }
    if (request.method === 'POST' && action === 'recheck') {
      const payload = await body(request)
      ok(response, reviewQueue.recheckReview(id, {
        decision: payload.decision as 'pending' | 'approved' | 'rejected' | 'needs_revision',
        ...(payload.reviewer === undefined ? {} : { reviewer: payload.reviewer as string }),
        ...(payload.reviewer_id === undefined ? {} : { reviewer_id: payload.reviewer_id as string }),
        ...(payload.reviewer_role === undefined ? {} : { reviewer_role: payload.reviewer_role as string }),
        ...(payload.policy_type === undefined ? {} : { policy_type: payload.policy_type as string }),
        ...(payload.note === undefined ? {} : { note: payload.note as string }),
      }), 201)
      return
    }
    if (request.method === 'POST' && action === 'open-location') { ok(response, await artifactIntelligence.openLocation(id)); return }
    if (request.method === 'POST' && action === 'open-file') { ok(response, await artifactIntelligence.openFile(id)); return }
    if (request.method === 'POST' && action === 'status') {
      const payload = await body(request)
      if (payload.status !== 'active' && payload.status !== 'archived') throw new Error('INVALID_ARTIFACT_STATUS_TRANSITION')
      ok(response, await artifactIntelligence.setArchived(id, payload.status === 'archived'))
      return
    }
    if (request.method === 'POST' && action === 'evidence') {
      const payload = await body(request)
      ok(response, artifactEvidence.create(id, payload as unknown as ArtifactEvidenceCreateInput), 201)
      return
    }
    if (request.method === 'DELETE' && action === undefined) {
      const removed = artifacts.deleteIndex(id)
      ok(response, { artifact: removed, file_deleted: false })
      return
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/document-search/search') {
    const payload = await body(request)
    ok(response, await bridgeRequest((payload.databaseRole === 'test' ? 'test' : 'production'), { ...payload, operation: 'search_document_chunks' }))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/document-search/chunk') {
    const payload = await body(request)
    ok(response, await bridgeRequest((payload.databaseRole === 'test' ? 'test' : 'production'), { ...payload, operation: 'get_document_chunk' }))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const payload = await body(request) as unknown as TaskCreateInput
    ok(response, tasks.create(payload), 201)
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/tasks') {
    ok(response, tasks.list(Number(url.searchParams.get('limit') ?? 50), {
      includeInternal: url.searchParams.get('include_internal') === '1',
      includeHidden: url.searchParams.get('include_hidden') === '1',
      status: url.searchParams.get('status') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
    })); return
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(start|cancel|retry|result|runtime|events|artifacts|save-report|export-word|hide|restore))?$/u)
  if (taskMatch !== null) {
    const id = decodeURIComponent(taskMatch[1]!)
    const action = taskMatch[2]
    if (request.method === 'GET' && action === undefined) {
      const task = tasks.get(id); if (task === undefined) { fail(response, 404, 'TASK_NOT_FOUND', '任务不存在。'); return }
      const inputAssetId = typeof task.metadata.inputAssetId === 'string' ? task.metadata.inputAssetId : null
      ok(response, {
        task, events: tasks.events(id), artifacts: artifacts.query({ task_id: id }), artifactCandidates: task.artifactIndex,
        input: inputAssetId === null ? null : inputs.get(inputAssetId),
      }); return
    }
    if (request.method === 'GET' && action === 'result') {
      const task = tasks.get(id); if (task === undefined) { fail(response, 404, 'TASK_NOT_FOUND', '任务不存在。'); return }
      ok(response, { status: task.status, resultText: task.resultText, citations: task.citationIndex, error: task.errorCode === null ? null : { code: task.errorCode, message: task.errorMessage } }); return
    }
    if (request.method === 'GET' && action === 'runtime') { ok(response, tasks.runtimeView(id)); return }
    if (request.method === 'GET' && action === 'events') {
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      response.setHeader('Cache-Control', 'no-cache')
      response.setHeader('Connection', 'keep-alive')
      response.flushHeaders()
      tasks.attachSse(id, response)
      return
    }
    if (request.method === 'GET' && action === 'artifacts') {
      const task = tasks.get(id); if (task === undefined) { fail(response, 404, 'TASK_NOT_FOUND', '任务不存在。'); return }
      ok(response, artifacts.query({ task_id: id })); return
    }
    if (request.method === 'POST' && action === 'save-report') {
      const payload = await body(request)
      ok(response, await tasks.saveAnswerAsReport(id, {
        ...(payload.auto_link_task === undefined ? {} : { auto_link_task: payload.auto_link_task as boolean }),
        ...(payload.auto_link_session === undefined ? {} : { auto_link_session: payload.auto_link_session as boolean }),
        ...(payload.evidence === undefined ? {} : { evidence: payload.evidence as ArtifactEvidenceCreateInput[] }),
      }), 201)
      return
    }
    if (request.method === 'POST' && action === 'export-word') {
      const payload = await body(request)
      ok(response, await tasks.exportAnswerAsWord(id, {
        ...(payload.auto_link_task === undefined ? {} : { auto_link_task: payload.auto_link_task as boolean }),
        ...(payload.auto_link_session === undefined ? {} : { auto_link_session: payload.auto_link_session as boolean }),
        ...(payload.evidence === undefined ? {} : { evidence: payload.evidence as ArtifactEvidenceCreateInput[] }),
      }), 201)
      return
    }
    if (request.method === 'POST' && action === 'start') { ok(response, await tasks.start(id), 202); return }
    if (request.method === 'POST' && action === 'cancel') { ok(response, await tasks.cancel(id)); return }
    if (request.method === 'POST' && action === 'retry') { ok(response, tasks.retry(id), 201); return }
    if (request.method === 'POST' && action === 'hide') { ok(response, tasks.hide(id)); return }
    if (request.method === 'POST' && action === 'restore') { ok(response, tasks.restore(id)); return }
  }
  fail(response, 404, 'API_NOT_FOUND', '接口不存在。')
}

const server = createServer((request, response) => {
  void route(request, response).catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    const status = /NOT_FOUND/u.test(message) ? 404 : /DENIED|INVALID|TOO_LARGE|CONFLICT|AMBIGUOUS|UNSUPPORTED|NOT_AVAILABLE|REQUIRED/u.test(message) ? 400 : 500
    fail(response, status, message.split(':')[0] || 'REQUEST_FAILED', message)
  })
})

async function shutdown(signal: string): Promise<void> {
  server.close()
  database.close()
  await rm(PATHS.runtimeState, { force: true })
  process.stdout.write(`${JSON.stringify({ type: 'workbench.shutdown', signal })}\n`)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown(signal).finally(() => process.exit(0)) })

await mkdir(path.dirname(PATHS.runtimeState), { recursive: true })
await access(path.join(PATHS.webDist, 'index.html')).catch(() => { throw new Error(`WEB_BUILD_MISSING: ${PATHS.webDist}`) })
server.listen(0, HOST, async () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('BIND_FAILED')
  boundPort = address.port
  const runtime = { host: HOST, port: boundPort, token: TOKEN, pid: process.pid, startedAt: new Date().toISOString(), url: `http://${HOST}:${boundPort}/?token=${encodeURIComponent(TOKEN)}` }
  await writeFile(PATHS.runtimeState, JSON.stringify(runtime, null, 2), 'utf8')
  process.stdout.write(`${JSON.stringify({ type: 'workbench.ready', ...runtime })}\n`)
})
