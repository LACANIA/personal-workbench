import type { TaskEvent, WorkbenchTask } from '../../../shared/contracts/index.ts'
import { PATHS, PROFILE_ALLOWLIST } from '../config.ts'
export { sanitizeHarnessNotification, shouldPersistHarnessNotification } from '../security/redaction.ts'

interface HarnessNotification {
  method: string
  params: Record<string, unknown>
}

interface RunResult {
  sessionId: string
  finalResponse: string
  events: unknown[]
  notifications: HarnessNotification[]
}

interface HarnessInstance {
  client: unknown
  start(): Promise<void>
  run(input: string, options: { sessionId: string; onNotification(notification: HarnessNotification): void }): Promise<RunResult>
  close(): Promise<void>
}

interface HarnessConstructor {
  new(options: Record<string, unknown>): HarnessInstance
}

export interface HarnessRunHooks {
  onReady(data: { sessionId: string; runtimePid: number | null }): void
  onNotification(notification: HarnessNotification): void
  registerCancel(close: () => Promise<void>): void
}

export interface HarnessRunOptions {
  inputPolicyOverlay?: string | null
}

export function harnessLaunchArgs(profile: string, patchPaths: string[]): string[] {
  // The official Harness loader requires this Node flag while it installs the
  // short-lived HMR service used to compose and watch profile patch layers.
  // Electron's executable is acting as the bundled Node runtime here.
  return [
    ...(PATHS.desktopMode ? ['--expose-internals'] : []),
    PATHS.harnessCli,
    '--profile',
    profile,
    ...patchPaths.flatMap(patchPath => ['--patch', patchPath]),
  ]
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (/(?:KEY|SECRET|TOKEN|PASSWORD|COOKIE|CREDENTIAL)/iu.test(name)) continue
    env[name] = value
  }
  return {
    ...env,
    DSH_HOME: PATHS.dshHome,
    // Ollama does not authenticate this loopback route. The Harness provider
    // schema still requires a non-empty credential reference, so use a fixed,
    // non-secret local marker after the generic secret filter above.
    OLLAMA_LOCAL_API_KEY: 'ollama-local',
    OLLAMA_NO_CLOUD: 'true',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'read-only',
    TSX_TSCONFIG_PATH: `${PATHS.harnessRoot}\\tsconfig.host.json`,
  }
}

function childPid(harness: HarnessInstance): number | null {
  const client = harness.client as object
  const child = Reflect.get(client, 'child') as { pid?: unknown } | undefined
  return typeof child?.pid === 'number' ? child.pid : null
}

export function buildHarnessPrompt(task: WorkbenchTask): string {
  const quoted = JSON.stringify(task.inputValue)
  const language = '请使用简体中文回答。'
  switch (task.templateId) {
    case 'file-analysis':
      return `${language} 必须调用 personal_read 读取 ${quoted}。分析该文件的主要配置；如果它是 package.json，请报告 Node 与 packageManager 要求。每项引用必须使用“<canonical_path>:<line或line-range>”格式。`
    case 'project-summary':
      return `${language} 项目名称为 ${JSON.stringify(task.projectName ?? task.inputValue)}。先调用 memory_get_project_context；如果提供了工作区，再调用个人只读文件工具核验关键资料。只写工具结果支持的事实，并复制工具返回的引用。`
    case 'memory-query':
      return `${language} 调用 memory_query 查询 ${quoted}${task.projectName ? `，project_name=${JSON.stringify(task.projectName)}` : ''}${task.inputValue.includes('%') ? '，entity_types=["decision","experiment"]' : '；除非用户明确指定实体类型，否则不要自行把 entity_types 限定为 document'}，并设置 include_sources=true。返回记录类型、Memory ID、Source ID、来源路径与定位。若结果为0项或项目不存在，只说明“${task.metadata.databaseRole === 'production' ? '正式 Research Memory 尚未录入相应内容。' : '测试 Research Memory 没有匹配内容。'}”，不要列出猜测原因。`
    case 'document-chunk-search':
      return `${language} 在 Document Chunk 中搜索 ${quoted}${task.projectName ? `，项目限定为 ${JSON.stringify(task.projectName)}` : ''}。先调用 memory_search_document_chunks，version_scope=latest，limit不超过5；取得真实 chunk_uid 后调用 memory_get_document_chunk。最终返回搜索Backend、Document、Version、Chunk UID、行范围、Snippet与API引用。`
    default:
      throw new Error(`HARNESS_TEMPLATE_UNSUPPORTED: ${task.templateId}`)
  }
}

export async function runHarnessTask(task: WorkbenchTask, hooks: HarnessRunHooks, options: HarnessRunOptions = {}): Promise<{ result: RunResult; durationMs: number }> {
  if (!(task.profile in PROFILE_ALLOWLIST)) throw new Error(`PROFILE_NOT_ALLOWED: ${task.profile}`)
  const imported = await import(PATHS.sdkClientUrl) as unknown as { DeepSeekHarness: HarnessConstructor }
  const workspace = task.workspacePath ?? PATHS.harnessRoot
  const patchPaths = [PATHS.sdkOverlay, ...(options.inputPolicyOverlay === null || options.inputPolicyOverlay === undefined ? [] : [options.inputPolicyOverlay])]
  const harness = new imported.DeepSeekHarness({
    launch: {
      command: process.execPath,
      args: harnessLaunchArgs(task.profile, patchPaths),
      cwd: PATHS.harnessRoot,
      env: safeEnvironment(),
      requestTimeoutMs: 300000,
      shutdownTimeoutMs: 3000,
      disposeEofGraceMs: 10000,
      disposeGraceMs: 5000,
    },
    cwd: workspace,
    provider: 'ollama-local',
    model: PATHS.modelName,
    maxTokens: 512,
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await harness.close()
  }
  hooks.registerCancel(close)
  const started = performance.now()
  try {
    await harness.start()
    const sessionId = `workbench-${task.id}`
    hooks.onReady({ sessionId, runtimePid: childPid(harness) })
    const result = await harness.run(buildHarnessPrompt(task), {
      sessionId,
      onNotification: hooks.onNotification,
    })
    return { result, durationMs: performance.now() - started }
  } finally {
    await close()
  }
}

export function harnessEventType(notification: HarnessNotification): string {
  if (notification.method === 'session.status') return `session.status.${String(notification.params.status ?? 'unknown')}`
  const event = notification.params.event as { type?: unknown } | undefined
  return typeof event?.type === 'string' ? event.type : notification.method
}

export function extractCitations(text: string): string[] {
  const results = new Set<string>()
  const bracketPatterns = [
    /\[Memory:[^\]]+\]/gu,
    /\[Source:[^\]]+\]/gu,
    /\[Chunk:[^\]]+\]/gu,
  ]
  for (const pattern of bracketPatterns) for (const match of text.matchAll(pattern)) results.add(match[0])
  const proseOnly = text.replace(/\[(?:Memory|Source|Chunk):[^\]]+\]/gu, '')
  for (const match of proseOnly.matchAll(/[A-Za-z]:\\[^:\r\n\]]+?:\d+(?:-\d+)?/gu)) results.add(match[0])
  return [...results]
}

export function eventSummary(event: TaskEvent): string {
  if (event.eventType.startsWith('session.status.')) return event.eventType.replace('session.status.', '会话：')
  return event.eventType
}
