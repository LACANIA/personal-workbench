import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectLocalConfig } from '../src/portable-config.ts'

describe('desktop first run', () => {
  it('creates isolated defaults with formal local models', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pwb-desktop-first-run-'))
    const config = detectLocalConfig(root, { ...process.env, PERSONAL_WORKBENCH_DESKTOP: '1', PATH: '' })
    expect(config.workspace_root).toBe(root)
    expect(config.project_path).toBe(root)
    expect(config.memory_path).toBe(path.join(root, 'data', 'research-memory.db'))
    expect(config.model_name).toBe('qwen3:8b')
    expect(config.embedding_model).toBe('qwen3-embedding:0.6b')
    expect(config.embedding_dimension).toBe(1024)
    expect(config.first_run_completed).toBe(false)
  })
})
