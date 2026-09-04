import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { backupBeforeMigration, prepareDataRoot, restoreMigrationBackup } from '../../desktop/runtime.mjs'

describe('desktop data migration', () => {
  it('backs up an existing database before recording a new app version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pwb-desktop-migration-'))
    await prepareDataRoot(root)
    await writeFile(path.join(root, 'config', 'install-state.json'), JSON.stringify({ version: '0.2.0' }))
    await mkdir(path.join(root, 'data'), { recursive: true })
    await writeFile(path.join(root, 'data', 'personal-workbench.db'), 'database-before-migration')
    const backup = await backupBeforeMigration(root, '0.3.0-beta.1')
    expect(backup).not.toBeNull()
    expect(await readFile(backup!, 'utf8')).toBe('database-before-migration')
    expect(JSON.parse(await readFile(path.join(root, 'config', 'install-state.json'), 'utf8')).version).toBe('0.3.0-beta.1')
  })

  it('restores the database and prior install state when startup migration fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pwb-desktop-restore-'))
    await prepareDataRoot(root)
    await writeFile(path.join(root, 'config', 'install-state.json'), JSON.stringify({ version: '0.2.0', schema_version: 1 }))
    await writeFile(path.join(root, 'data', 'personal-workbench.db'), 'database-before-migration')
    const backup = await backupBeforeMigration(root, '0.3.0-beta.1')
    await writeFile(path.join(root, 'data', 'personal-workbench.db'), 'broken-migration')
    expect(await restoreMigrationBackup(root, backup!)).toBe(true)
    expect(await readFile(path.join(root, 'data', 'personal-workbench.db'), 'utf8')).toBe('database-before-migration')
    expect(JSON.parse(await readFile(path.join(root, 'config', 'install-state.json'), 'utf8')).version).toBe('0.2.0')
  })
})
