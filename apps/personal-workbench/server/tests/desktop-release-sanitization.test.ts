import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const groups = await Promise.all(entries.map(async entry => {
    const absolute = path.join(root, entry.name)
    if (entry.isSymbolicLink()) return []
    return entry.isDirectory() ? files(absolute) : [absolute]
  }))
  return groups.flat()
}

async function links(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const groups = await Promise.all(entries.map(async entry => {
    const absolute = path.join(root, entry.name)
    if (entry.isSymbolicLink()) return [absolute]
    return entry.isDirectory() ? links(absolute) : []
  }))
  return groups.flat()
}

describe('desktop release sanitization', () => {
  it('contains no mutable database, validation fixture or personal config', async () => {
    const root = path.resolve('desktop-release/app-runtime')
    const releaseExists = await stat(root).then(value => value.isDirectory()).catch(() => false)
    if (!releaseExists) return
    expect(await links(root)).toEqual([])
    const relative = (await files(root)).map(file => path.relative(root, file).replaceAll('\\', '/').toLowerCase())
    expect(relative.some(file => file.endsWith('.db') || file.includes('validation-') || file.includes('screenshots/') || file.endsWith('local-config.json'))).toBe(false)
    const textFiles = relative.filter(file => /\.(?:js|json|html|css|py|ps1|cmd|ya?ml)$/u.test(file))
    for (let offset = 0; offset < textFiles.length; offset += 200) {
      const contents = await Promise.all(textFiles.slice(offset, offset + 200).map(async relativeFile => ({
        relativeFile,
        text: await readFile(path.join(root, relativeFile), 'utf8'),
      })))
      const developmentRoot = ['E:', '\\AI-Agent-Lab'].join('')
      const developmentUser = ['32', '377'].join('')
      for (const { text } of contents) {
        expect(text).not.toContain(developmentRoot)
        expect(text).not.toContain(`C:\\Users\\${developmentUser}`)
        expect(text).not.toContain(`\\${developmentUser}\\`)
      }
    }
  }, 60_000)
})
