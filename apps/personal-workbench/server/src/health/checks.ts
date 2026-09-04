import { access, readFile, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { LOCAL_CONFIG, PATHS, PROFILE_ALLOWLIST } from '../config.ts'
import { runProcess } from '../process.ts'
import { loadAllowedRoots } from '../security/path-policy.ts'

export interface CheckResult {
  id: string
  label: string
  status: 'ok' | 'warning' | 'error'
  summary: string
  details?: Record<string, unknown>
}

async function exists(value: string): Promise<boolean> {
  try { await access(value); return true } catch { return false }
}

function memoryStatus(databasePath: string, role: 'production' | 'test'): CheckResult {
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true })
    db.exec('PRAGMA query_only=ON')
    const userVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    const chunks = Number((db.prepare('SELECT COUNT(*) AS n FROM document_chunks').get() as { n: number }).n)
    const fts = Number((db.prepare('SELECT COUNT(*) AS n FROM document_chunks_fts').get() as { n: number }).n)
    const state = db.prepare('SELECT tokenizer, status, source_chunk_count, indexed_row_count, validated_at FROM document_chunk_fts_state WHERE id=1').get() as Record<string, unknown> | undefined
    db.close()
    return {
      id: `memory-${role}`,
      label: role === 'production' ? 'Research Memory 正式库' : 'Research Memory 测试库',
      status: userVersion === 4 && state?.status === 'valid' && chunks === fts ? 'ok' : 'error',
      summary: `Schema v${userVersion} · Chunk ${chunks} · FTS ${fts}`,
      details: { databaseRole: role, userVersion, chunks, fts, ftsState: state },
    }
  } catch (error) {
    return { id: `memory-${role}`, label: `Research Memory ${role}`, status: 'error', summary: String(error) }
  }
}

export async function collectHealth(): Promise<{ status: string; checkedAt: string; checks: CheckResult[]; metrics: Record<string, number> }> {
  const started = performance.now()
  const checks: CheckResult[] = []
  const ollamaStarted = performance.now()
  try {
    const response = await fetch(new URL('/api/tags', `${PATHS.ollamaEndpoint}/`), { signal: AbortSignal.timeout(3000) })
    const body = await response.json() as { models?: { name: string }[] }
    const names = body.models?.map(item => item.name) ?? []
    checks.push({
      id: 'ollama', label: 'Ollama', status: response.ok ? 'ok' : 'error',
      summary: response.ok ? `本机接口可用 · ${names.length} 个模型` : `HTTP ${response.status}`,
      details: { endpoint: PATHS.ollamaEndpoint, models: names },
    })
    for (const model of [LOCAL_CONFIG.model_name, 'qwen2.5-coder:7b']) {
      checks.push({ id: `model-${model}`, label: model, status: names.includes(model) ? 'ok' : 'error', summary: names.includes(model) ? '已安装' : '未检测到' })
    }
  } catch (error) {
    checks.push({ id: 'ollama', label: 'Ollama', status: 'error', summary: `本机接口不可用：${String(error)}` })
  }
  const git = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: PATHS.harnessRoot, timeoutMs: 3000 }).catch(() => undefined)
  checks.push({
    id: 'harness', label: 'DeepSeek Harness',
    status: git?.exitCode === 0 && git.stdout.trim() === '47f943859bef60e4160492346772ded9b24f765a' ? 'ok' : 'error',
    summary: git?.exitCode === 0 ? git.stdout.trim().slice(0, 12) : '目录或 Git 状态读取失败',
    details: { root: PATHS.harnessRoot, commit: git?.stdout.trim() ?? null },
  })
  for (const profile of Object.keys(PROFILE_ALLOWLIST)) {
    const present = await exists(`${PATHS.dshHome}\\profiles\\${profile}\\cordis.patch.yml`)
    checks.push({ id: `profile-${profile}`, label: profile, status: present ? 'ok' : 'error', summary: present ? '可加载' : '缺少配置' })
  }
  checks.push(memoryStatus(PATHS.memoryProduction, 'production'), memoryStatus(PATHS.memoryTest, 'test'))
  try {
    const roots = await loadAllowedRoots()
    checks.push({ id: 'path-policy', label: '路径许可策略', status: 'ok', summary: `${roots.length} 个允许根`, details: { roots } })
  } catch (error) {
    checks.push({ id: 'path-policy', label: '路径许可策略', status: 'error', summary: String(error) })
  }
  const legacyPresent = await exists(PATHS.legacyRoot)
  checks.push({ id: 'legacy', label: 'Legacy Video2Skill', status: legacyPresent ? 'ok' : 'warning', summary: legacyPresent ? '只读审计目录存在' : '旧目录未检测到' })
  const disk = await stat(PATHS.dataRoot).catch(() => undefined)
  if (disk !== undefined) checks.push({ id: 'workbench', label: 'Personal Workbench', status: 'ok', summary: '本机控制服务已启动' })
  const gpu = await runProcess('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { timeoutMs: 4000 }).catch(() => undefined)
  checks.push({ id: 'gpu', label: 'NVIDIA GPU', status: gpu?.exitCode === 0 ? 'ok' : 'warning', summary: gpu?.exitCode === 0 ? gpu.stdout.trim() : '当前未取得 GPU 指标' })
  const overall = checks.some(item => item.status === 'error') ? 'degraded' : 'ok'
  return {
    status: overall,
    checkedAt: new Date().toISOString(),
    checks,
    metrics: { totalMs: Math.round((performance.now() - started) * 1000) / 1000, ollamaMs: Math.round((performance.now() - ollamaStarted) * 1000) / 1000 },
  }
}

export async function getLegacyReuseStatus(): Promise<Record<string, unknown>> {
  const present = await exists(PATHS.legacyRoot)
  let manifest: unknown = []
  try { manifest = JSON.parse(await readFile(PATHS.legacyManifest, 'utf8')) as unknown } catch { /* report status below */ }
  const rows = Array.isArray(manifest)
    ? manifest as Record<string, unknown>[]
    : Array.isArray((manifest as { entries?: unknown } | null)?.entries)
      ? (manifest as { entries: Record<string, unknown>[] }).entries
      : []
  const counts = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map(key => [key, rows.filter(item => item.classification === key).length]))
  return {
    present,
    root: present ? PATHS.legacyRoot : null,
    auditReportAvailable: await exists(PATHS.legacyAudit),
    manifestAvailable: rows.length > 0,
    auditedAt: '2026-08-16T15:00:00Z',
    counts,
    totalCandidates: rows.length,
    state: 'legacy-audit',
    mediaPipelineEnabled: false,
  }
}
