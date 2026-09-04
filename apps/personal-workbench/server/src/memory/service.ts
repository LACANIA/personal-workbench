import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import type { MemoryEntityType } from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { runProcess } from '../process.ts'

export type MemoryRole = 'production' | 'test'

function databasePath(role: MemoryRole): string {
  return role === 'test' ? PATHS.memoryTest : PATHS.memoryProduction
}

const MEMORY_ENTITIES: Record<MemoryEntityType, { table: string; label: string }> = {
  project: { table: 'projects', label: 'name' },
  decision: { table: 'decisions', label: 'title' },
  experiment: { table: 'experiments', label: 'name' },
  document: { table: 'documents', label: 'path' },
  task: { table: 'tasks', label: 'description' },
  session: { table: 'sessions', label: 'model' },
}

function readOnlyDatabase<T>(role: MemoryRole, reader: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath(role), { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON')
    return reader(db)
  } finally {
    db.close()
  }
}

export function readMemoryEntity(role: MemoryRole, entityType: MemoryEntityType, id: string): Record<string, unknown> | undefined {
  const entity = MEMORY_ENTITIES[entityType]
  return readOnlyDatabase(role, db => {
    const row = entityType === 'project'
      ? db.prepare(`
          SELECT e.id, e.${entity.label} AS label, e.id AS project_id, e.name AS project_name
          FROM ${entity.table} e
          WHERE CAST(e.id AS TEXT) = ?
        `).get(id) as Record<string, unknown> | undefined
      : entityType === 'session'
        ? db.prepare(`
            SELECT e.id, e.${entity.label} AS label, t.project_id, p.name AS project_name
            FROM ${entity.table} e
            JOIN tasks t ON t.id = e.task_id
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE CAST(e.id AS TEXT) = ?
          `).get(id) as Record<string, unknown> | undefined
      : db.prepare(`
          SELECT e.id, e.${entity.label} AS label, e.project_id, p.name AS project_name
          FROM ${entity.table} e
          LEFT JOIN projects p ON p.id = e.project_id
          WHERE CAST(e.id AS TEXT) = ?
        `).get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : { ...row, entity_type: entityType, database_role: role }
  })
}

export function readMemorySource(role: MemoryRole, id: string): Record<string, unknown> | undefined {
  return readOnlyDatabase(role, db => {
    const row = db.prepare(`
      SELECT s.id, s.source_type, s.project_id, p.name AS project_name,
             COALESCE(NULLIF(s.canonical_path, ''), NULLIF(s.external_ref, ''), 'Source ' || s.id) AS label
      FROM sources s
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE CAST(s.id AS TEXT) = ?
    `).get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : { ...row, database_role: role }
  })
}

export function readDocumentChunkIdentity(role: MemoryRole, chunkUid: string): Record<string, unknown> | undefined {
  return readOnlyDatabase(role, db => {
    const row = db.prepare(`
      SELECT dc.id AS chunk_id, dc.chunk_uid, dc.start_line, dc.end_line,
             dv.id AS document_version_id, dv.memory_document_id AS document_id,
             dv.source_id, da.canonical_path, da.title, p.name AS project_name
      FROM document_chunks dc
      JOIN document_versions dv ON dv.id = dc.document_version_id
      JOIN document_assets da ON da.id = dv.asset_id
      JOIN projects p ON p.id = da.project_id
      WHERE dc.chunk_uid = ? COLLATE NOCASE
    `).get(chunkUid) as Record<string, unknown> | undefined
    return row === undefined ? undefined : { ...row, database_role: role }
  })
}

export function readMemoryStatus(role: MemoryRole): Record<string, unknown> {
  if (!existsSync(databasePath(role))) {
    return {
      role, userVersion: 0, queryOnly: 1,
      counts: Object.fromEntries(['projects', 'decisions', 'experiments', 'documents', 'tasks', 'sessions', 'sources', 'document_assets', 'document_versions', 'document_chunks'].map(name => [name, 0])),
      ftsCount: 0, ftsState: null, status: 'empty', message: '尚未建立研究记忆。',
    }
  }
  const db = new DatabaseSync(databasePath(role), { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  const tableNames = ['projects', 'decisions', 'experiments', 'documents', 'tasks', 'sessions', 'sources', 'document_assets', 'document_versions', 'document_chunks']
  const counts = Object.fromEntries(tableNames.map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n)]))
  const userVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  const queryOnly = Number((db.prepare('PRAGMA query_only').get() as { query_only: number }).query_only)
  const ftsCount = Number((db.prepare('SELECT COUNT(*) AS n FROM document_chunks_fts').get() as { n: number }).n)
  const ftsState = db.prepare('SELECT * FROM document_chunk_fts_state WHERE id=1').get() ?? null
  db.close()
  return { role, userVersion, queryOnly, counts, ftsCount, ftsState }
}

export function listProjects(role: MemoryRole): Record<string, unknown>[] {
  if (!existsSync(databasePath(role))) return []
  const db = new DatabaseSync(databasePath(role), { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  const rows = db.prepare('SELECT id, name, description, root_path, status, updated_at FROM projects ORDER BY name').all() as Record<string, unknown>[]
  db.close()
  return rows
}

export async function bridgeRequest(role: MemoryRole, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const started = performance.now()
  const result = await runProcess('python', [PATHS.memoryBridge, '--database', databasePath(role)], {
    cwd: PATHS.myAgentRoot,
    timeoutMs: 20000,
    input: JSON.stringify(payload),
    env: { ...process.env, PYTHONUTF8: '1' },
  })
  if (result.timedOut) throw new Error('MEMORY_BRIDGE_TIMEOUT')
  if (result.exitCode !== 0) throw new Error(`MEMORY_BRIDGE_EXIT_${result.exitCode}: ${result.stderr.slice(-1000)}`)
  const decoded = JSON.parse(result.stdout) as Record<string, unknown>
  return { ...decoded, workbenchBridgeMs: Math.round((performance.now() - started) * 1000) / 1000 }
}
