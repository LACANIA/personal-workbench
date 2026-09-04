import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('file organizer consumer UI', () => {
  it('keeps the confirmation gate and folder-only entry in the consumer page', async () => {
    const source = await readFile(path.resolve('web/src/pages/FileOrganizerPage.tsx'), 'utf8')
    expect(source).toContain('选择文件夹')
    expect(source).toContain('扫描并生成建议')
    expect(source).toContain('只有你确认后')
    expect(source).toContain('第一版不会删除文件')
  })
})
