import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectLocalConfig, validateLocalConfig } from '../src/portable-config.ts'

describe('desktop production config', () => {
  it('keeps every mutable default inside the selected user data root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pwb-desktop-config-'))
    const config = validateLocalConfig(detectLocalConfig(root, { ...process.env, PERSONAL_WORKBENCH_DESKTOP: '1' }))
    for (const value of [config.project_path, config.memory_path, config.harness_root, config.dsh_home, config.backup_root]) {
      expect(path.relative(root, value).startsWith('..')).toBe(false)
    }
  })
})
