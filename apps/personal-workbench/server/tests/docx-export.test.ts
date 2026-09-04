import { describe, expect, it } from 'vitest'
import { createDocxFromMarkdown, readDocxDocumentXml, validateDocx } from '../src/reports/docx.ts'

describe('STEP-33 DOCX export', () => {
  it('creates an A4 Office Open XML Word document with headings, tables, code and source text', () => {
    const buffer = createDocxFromMarkdown([
      '来源：本地文本资料', '生成时间：2026-09-01 12:00', '',
      '# 一、内容概览', '这是一份中文学习资料。', '',
      '# 二、学习目标', '- 理解变量。', '- 保留来源。', '',
      '# 三、核心知识', '## 变量与函数', '函数可以表达变量关系。', '',
      '# 四、关键术语', '| 术语 | 解释 |', '| --- | --- |', '| 变量 | 可以变化的量 |', '',
      '# 五、公式 / 代码', '$$y = 2x + 1$$', '```ts', 'const y = 2 * x + 1', '```', '',
      '# 十、来源', '- 本地文本资料：source.md',
    ].join('\n'), '本地文本学习笔记')
    validateDocx(buffer)
    expect(buffer.subarray(0, 2).toString('ascii')).toBe('PK')
    const xml = readDocxDocumentXml(buffer)
    expect(xml).toContain('本地文本学习笔记')
    expect(xml).toContain('Heading1')
    expect(xml).toContain('变量')
    expect(xml).toContain('source.md')
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('<w:numPr>')
    expect(xml).toContain('w:w="11906"')
    expect(xml).toContain('w:pStyle w:val="Formula"')
  })

  it('does not let a one-line fenced code sample consume later headings or tables', () => {
    const buffer = createDocxFromMarkdown([
      '# 一、核心知识', '```ts const y = 2 * x + 1 ```', '',
      '# 二、关键术语', '| 术语 | 解释 |', '| --- | --- |', '| 变量 | 可以变化的量 |',
    ].join('\n'), '代码学习笔记')
    const xml = readDocxDocumentXml(buffer)
    expect(xml).toContain('关键术语')
    expect(xml).not.toContain('# 二、关键术语')
    expect(xml).toContain('<w:tbl>')
  })
})
