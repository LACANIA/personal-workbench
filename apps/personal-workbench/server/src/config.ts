import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import type { DatabaseRole, TaskTemplate, TemplateId } from '../../shared/contracts/index.ts'
import { defaultLegacyRoot, DETECTED_APP_ROOT, loadOrCreateLocalConfig } from './portable-config.ts'

const RESOURCE_ROOT = path.resolve(process.env.PERSONAL_WORKBENCH_RESOURCE_ROOT ?? DETECTED_APP_ROOT)
const DATA_ROOT = path.resolve(process.env.PERSONAL_WORKBENCH_DATA_ROOT ?? DETECTED_APP_ROOT)
const DESKTOP_MODE = process.env.PERSONAL_WORKBENCH_DESKTOP === '1'
const CONFIG_PATH = DESKTOP_MODE ? path.join(DATA_ROOT, 'config', 'local-config.json') : path.join(DATA_ROOT, 'local-config.json')
export const LOCAL_CONFIG = Object.freeze(loadOrCreateLocalConfig({ appRoot: DATA_ROOT, configPath: CONFIG_PATH }))
const HARNESS_ROOT = DESKTOP_MODE ? path.join(RESOURCE_ROOT, 'harness') : LOCAL_CONFIG.harness_root
const DSH_HOME = process.env.NODE_ENV === 'test' && process.env.PERSONAL_WORKBENCH_TEST_DSH_HOME
  ? path.resolve(process.env.PERSONAL_WORKBENCH_TEST_DSH_HOME)
  : LOCAL_CONFIG.dsh_home
const REPORTS_ROOT = path.join(LOCAL_CONFIG.workspace_root, 'reports')
const GENERATED_OVERLAY = path.join(DATA_ROOT, 'runtime', 'generated-sdk-runtime.patch.yml')

function openAiBaseUrl(): string {
  const endpoint = new URL(LOCAL_CONFIG.ollama_endpoint)
  endpoint.pathname = '/v1'
  endpoint.search = ''
  endpoint.hash = ''
  return endpoint.toString().replace(/\/$/u, '')
}

function writeSdkOverlay(): void {
  mkdirSync(path.dirname(GENERATED_OVERLAY), { recursive: true })
  const sdkServerUrl = pathToFileURL(path.join(HARNESS_ROOT, 'packages', 'sdk', 'server', 'lib', 'index.js')).href
  const source = [
    '# Generated from local-config.json by Personal Workbench.',
    '- id: headless-startup',
    '  disabled: true',
    '',
    '- id: headless-runner',
    '  disabled: true',
    '',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      ollama-local:',
    '        displayName: Ollama Local',
    '        apiKeyEnv: OLLAMA_LOCAL_API_KEY',
    '        api: openai-completions',
    `        baseURL: ${openAiBaseUrl()}`,
    '        reasoning: off',
    '        timeoutMs: 120000',
    '        streamIdleTimeoutMs: 120000',
    '        models:',
    '          - id: qwen2.5-coder:7b',
    '            name: Qwen 2.5 Coder 7B',
    '            contextWindow: 8192',
    '            maxTokens: 128',
    '            input: [text]',
    `          - id: ${LOCAL_CONFIG.model_name}`,
    `            name: ${LOCAL_CONFIG.model_name}`,
    '            contextWindow: 8192',
    '            maxTokens: 512',
    '            input: [text]',
    '            reasoningEfforts:',
    '              off: none',
    '              high: high',
    '',
    '- insert:',
    '    - id: sdk-jsonrpc-server',
    `      name: '${sdkServerUrl}'`,
    '',
  ].join('\n')
  writeFileSync(GENERATED_OVERLAY, source, 'utf8')
}

function prepareDataRoot(): void {
  for (const directory of ['data', 'config', 'logs', 'runtime', 'cache', 'output', 'backup', 'personal-inbox/incoming']) {
    mkdirSync(path.join(DATA_ROOT, directory), { recursive: true })
  }
  mkdirSync(DSH_HOME, { recursive: true })
  const policy = path.join(DSH_HOME, 'personal-path-policy.yaml')
  if (!existsSync(policy)) {
    try {
      writeFileSync(policy, `${JSON.stringify({ allowedRoots: [LOCAL_CONFIG.project_path] }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

function writeDesktopHarnessProfile(): void {
  if (!DESKTOP_MODE || !existsSync(path.join(HARNESS_ROOT, 'apps', 'cli', 'lib', 'bin.js'))) return
  const moduleFallback = path.join(DSH_HOME, 'node_modules')
  if (!existsSync(moduleFallback)) symlinkSync(path.join(HARNESS_ROOT, 'node_modules'), moduleFallback, process.platform === 'win32' ? 'junction' : 'dir')
  const profileRoot = path.join(DSH_HOME, 'profiles', 'personal-safe-readonly')
  mkdirSync(profileRoot, { recursive: true })
  writeFileSync(path.join(profileRoot, 'cordis.yml'), '[]\n', 'utf8')
  writeFileSync(path.join(profileRoot, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-personal-safe-readonly',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, null, 2)}\n`, 'utf8')
  const pluginUrl = pathToFileURL(path.join(HARNESS_ROOT, 'node_modules', '@local', 'personal-safe-fs', 'src', 'index.js')).href
  const patch = [
    '- id: agent-default-model',
    '  config:',
    '    provider: ollama-local',
    `    model: ${LOCAL_CONFIG.model_name}`,
    '',
    ...['session-title-llm', 'agent-instructions', 'tool-skill', 'tool-web', 'plan-mode', 'tool-jobs',
      'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
      'tool-subagent-report', 'tool-workflow', 'tool-todo', 'tool-goal', 'tool-ralph',
      'tool-str-replace-editor', 'tool-pwsh', 'tool-bash', 'tool-fs', 'tool-fs-search']
      .flatMap(id => [`- id: ${id}`, '  disabled: true', '']),
    '- insert:',
    '    - id: personal-safe-fs',
    `      name: '${pluginUrl}'`,
    '      config:',
    `        policyPath: '${path.join(DSH_HOME, 'personal-path-policy.yaml').replaceAll("'", "''")}'`,
    '',
  ].join('\n')
  writeFileSync(path.join(profileRoot, 'cordis.patch.yml'), patch, 'utf8')
}

prepareDataRoot()
writeDesktopHarnessProfile()
if (existsSync(HARNESS_ROOT)) writeSdkOverlay()

export const PATHS = Object.freeze({
  appRoot: RESOURCE_ROOT,
  resourceRoot: RESOURCE_ROOT,
  dataRoot: DATA_ROOT,
  desktopMode: DESKTOP_MODE,
  labRoot: LOCAL_CONFIG.workspace_root,
  myAgentRoot: LOCAL_CONFIG.project_path,
  personalInbox: path.join(LOCAL_CONFIG.project_path, 'personal-inbox'),
  personalInboxIncoming: path.join(LOCAL_CONFIG.project_path, 'personal-inbox', 'incoming'),
  temporaryInputRuntime: path.join(os.tmpdir(), 'personal-workbench-input-grants'),
  harnessRoot: HARNESS_ROOT,
  harnessCli: path.join(HARNESS_ROOT, 'apps', 'cli', 'lib', 'bin.js'),
  sdkClientUrl: pathToFileURL(path.join(HARNESS_ROOT, 'packages', 'sdk', 'client', 'lib', 'index.js')).href,
  sdkOverlay: GENERATED_OVERLAY,
  dshHome: DSH_HOME,
  policy: path.join(DSH_HOME, 'personal-path-policy.yaml'),
  memoryProduction: LOCAL_CONFIG.memory_path,
  memoryTest: path.join(LOCAL_CONFIG.project_path, 'memory', 'tests', 'test_research_memory.db'),
  memoryBridge: path.join(LOCAL_CONFIG.project_path, 'memory', 'api', 'read_only_bridge.py'),
  legacyRoot: defaultLegacyRoot(),
  legacyManifest: path.join(REPORTS_ROOT, 'video2skill-reuse-manifest-step15.json'),
  legacyAudit: path.join(REPORTS_ROOT, 'VIDEO2SKILL_LEGACY_REUSE_AUDIT_STEP_15.md'),
  workbenchDb: path.join(DATA_ROOT, 'data', 'personal-workbench.db'),
  runtimeState: process.env.PERSONAL_WORKBENCH_RUNTIME_STATE ?? path.join(DATA_ROOT, 'runtime', 'server-state.json'),
  webDist: path.join(RESOURCE_ROOT, 'web', 'dist'),
  logs: path.join(DATA_ROOT, 'logs'),
  reviewSnapshots: path.join(DATA_ROOT, 'data', 'review-snapshots'),
  backups: LOCAL_CONFIG.backup_root,
  releases: path.join(DATA_ROOT, 'output', 'releases'),
  videoData: path.join(DATA_ROOT, 'data', 'video-knowledge'),
  /** Public GitHub repositories are cloned only into this managed transient runtime area. */
  githubRuntime: path.join(LOCAL_CONFIG.project_path, 'runtime', 'github'),
  localConfig: CONFIG_PATH,
  ollamaEndpoint: LOCAL_CONFIG.ollama_endpoint,
  modelName: LOCAL_CONFIG.model_name,
  ollamaExecutable: LOCAL_CONFIG.ollama_executable,
  ffmpegExecutable: LOCAL_CONFIG.ffmpeg_executable,
  ffprobeExecutable: LOCAL_CONFIG.ffprobe_executable,
  ytdlpExecutable: LOCAL_CONFIG.ytdlp_executable,
  asrPython: LOCAL_CONFIG.asr_python,
  asrModelPath: LOCAL_CONFIG.asr_model_path,
  asrDevice: LOCAL_CONFIG.asr_device,
  asrComputeType: LOCAL_CONFIG.asr_compute_type,
  asrGpuRuntimeRoot: LOCAL_CONFIG.asr_gpu_runtime_root,
  asrGpuAvailable: LOCAL_CONFIG.asr_gpu_available,
  asrLastDiagnosticAt: LOCAL_CONFIG.asr_last_diagnostic_at,
  embeddingProvider: LOCAL_CONFIG.embedding_provider,
  embeddingModel: LOCAL_CONFIG.embedding_model,
  embeddingDimension: LOCAL_CONFIG.embedding_dimension,
})

export const PROFILE_ALLOWLIST = Object.freeze({
  'personal-safe-readonly': { model: LOCAL_CONFIG.model_name, databaseRole: null },
  'personal-research': { model: LOCAL_CONFIG.model_name, databaseRole: 'production' },
  'personal-research-test': { model: LOCAL_CONFIG.model_name, databaseRole: 'test' },
} satisfies Record<string, { model: string; databaseRole: DatabaseRole | null }>)

export const TEMPLATES: readonly TaskTemplate[] = Object.freeze([
  {
    id: 'file-organizer', label: '整理文件', description: '扫描用户明确选择的文件夹，生成可确认的整理计划。', enabled: true,
    execution: 'deterministic', profile: '', capabilities: [],
  },
  {
    id: 'file-analysis',
    label: '文件分析',
    description: '读取允许目录中的文本、代码或配置，并按路径与行号给出结果。',
    enabled: true,
    execution: 'harness',
    profile: 'personal-safe-readonly',
    capabilities: ['personal_read', 'personal_glob', 'personal_grep'],
  },
  {
    id: 'project-summary',
    label: '项目总结',
    description: '联合项目记忆与经过许可的文件证据，形成带引用的项目概览。',
    enabled: true,
    execution: 'harness',
    profile: 'personal-research',
    capabilities: ['memory_get_project_context', 'personal_read'],
  },
  {
    id: 'memory-query',
    label: '记忆查询',
    description: '查询结构化项目记录、来源和定位。',
    enabled: true,
    execution: 'harness',
    profile: 'personal-research',
    capabilities: ['memory_query', 'memory_get_project_context'],
  },
  {
    id: 'document-chunk-search',
    label: '文档证据检索',
    description: '搜索文档分块并按需精确读取，返回版本、行号和确定性引用。',
    enabled: true,
    execution: 'harness',
    profile: 'personal-research',
    capabilities: ['memory_search_document_chunks', 'memory_get_document_chunk'],
  },
  {
    id: 'asset-inventory',
    label: '资产清单',
    description: '在用户指定目录内确定性统计文件、目录、容量和扩展名分布。',
    enabled: true,
    execution: 'deterministic',
    profile: null,
    capabilities: ['local-asset-counter'],
  },
  {
    id: 'video-to-knowledge',
    label: '视频知识任务',
    description: '在本机处理字幕、视频或网址来源，生成带时间戳的知识产物并进入人工审核流程。',
    enabled: true,
    execution: 'video',
    profile: null,
    capabilities: ['subtitle-parser', 'segmenter', 'local-embedding', 'knowledge-graph', 'review-gate'],
  },
  {
    id: 'knowledge-ingestion',
    label: '知识输入登记',
    description: '识别资料来源并路由到当前可用的本机处理链路；公开网页与公开 GitHub 仓库会经受控读取、清洗和本地整理后生成资料。',
    enabled: true,
    execution: 'planned',
    profile: null,
    capabilities: ['source-detector', 'pipeline-router', 'task-runtime'],
  },
])

export function templateById(id: TemplateId): TaskTemplate {
  const template = TEMPLATES.find(item => item.id === id)
  if (template === undefined) throw new Error(`UNKNOWN_TEMPLATE: ${id}`)
  return template
}

export function profileForTemplate(id: TemplateId, databaseRole: DatabaseRole): string {
  if (id === 'file-analysis') return 'personal-safe-readonly'
  if (id === 'project-summary' || id === 'memory-query' || id === 'document-chunk-search') {
    return databaseRole === 'test' ? 'personal-research-test' : 'personal-research'
  }
  return ''
}
