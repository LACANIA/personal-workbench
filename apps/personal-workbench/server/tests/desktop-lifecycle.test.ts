import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearStaleServerState, createDiagnosticsZip, parseServerReadyLine } from '../../desktop/runtime.mjs'

describe('desktop lifecycle', () => {
  it('accepts only authenticated loopback ready messages', () => {
    const valid = JSON.stringify({ type: 'workbench.ready', port: 43121, token: 'x'.repeat(40), url: `http://127.0.0.1:43121/?token=${'x'.repeat(40)}` })
    expect(parseServerReadyLine(valid)?.port).toBe(43121)
    expect(parseServerReadyLine(JSON.stringify({ type: 'workbench.ready', port: 43121, token: 'x'.repeat(40), url: 'http://0.0.0.0:43121/' }))).toBeNull()
  })

  it('removes a stale server state file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pwb-desktop-lifecycle-'))
    const state = path.join(root, 'runtime.json')
    await writeFile(state, JSON.stringify({ pid: 2147483000 }))
    expect(await clearStaleServerState(state)).toBe(true)
    await expect(readFile(state)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates a real ZIP diagnostics package without user content', () => {
    const zip = createDiagnosticsZip([{ name: 'diagnostics.json', data: '{"status":"ok"}\n' }])
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304')
    expect(zip.includes(Buffer.from('diagnostics.json'))).toBe(true)
    expect(zip.subarray(-22, -18).toString('hex')).toBe('504b0506')
  })
})
