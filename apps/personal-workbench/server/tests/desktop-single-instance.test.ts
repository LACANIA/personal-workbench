import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('desktop single instance', () => {
  it('uses Electron lock and focuses the existing window', async () => {
    const source = await readFile('desktop/main.mjs', 'utf8')
    expect(source).toContain('app.requestSingleInstanceLock()')
    expect(source).toContain("app.on('second-instance', showWindow)")
  })
})
