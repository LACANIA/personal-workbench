import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { DetectedKnowledgeSource } from '../../shared/contracts/index.ts'
import { PATHS } from '../src/config.ts'
import { DocumentSourceAdapter, readOfficeZip } from '../src/sources/document-source-adapter.ts'

const roots: string[] = []
const adapter = new DocumentSourceAdapter()

function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name); const source = Buffer.from(text); const compressed = deflateRawSync(source)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(nameBuffer.length, 26); local.writeUInt16LE(0, 28)
    locals.push(local, nameBuffer, compressed)
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0, 8); header.writeUInt16LE(8, 10); header.writeUInt32LE(0, 16); header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(source.length, 24); header.writeUInt16LE(nameBuffer.length, 28); header.writeUInt16LE(0, 30); header.writeUInt16LE(0, 32); header.writeUInt16LE(0, 34); header.writeUInt16LE(0, 36); header.writeUInt32LE(0, 38); header.writeUInt32LE(offset, 42)
    central.push(header, nameBuffer); offset += local.length + nameBuffer.length + compressed.length
  }
  const centralBody = Buffer.concat(central); const footer = Buffer.alloc(22); footer.writeUInt32LE(0x06054b50, 0); footer.writeUInt16LE(Object.keys(entries).length, 8); footer.writeUInt16LE(Object.keys(entries).length, 10); footer.writeUInt32LE(centralBody.length, 12); footer.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBody, footer])
}
async function source(name: string, body: Buffer): Promise<{ root: string; detected: DetectedKnowledgeSource }> {
  const root = path.join(PATHS.appRoot, 'data', 'test-runtime', `step35-${randomUUID()}`); roots.push(root); await mkdir(root, { recursive: true })
  const file = path.join(root, name); await writeFile(file, body)
  return { root, detected: { source_type: 'local_file', source_reference: file, display_name: name, metadata: { input_asset_id: randomUUID(), source_mode: 'drag_drop' } } }
}
const context = { taskId: 'step35-task', projectId: 'step35-project', report: () => undefined }

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('STEP-35 DocumentSourceAdapter', () => {
  it('restores DOCX headings, paragraphs and tables without extracting the ZIP', async () => {
    const fixture = await source('lecture.docx', zip({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第二章 函数</w:t></w:r></w:p><w:p><w:r><w:t>函数描述输入与输出之间的关系。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>参数</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>含义</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    }))
    const document = await adapter.acquire(fixture.detected, context)
    expect(document.metadata.document_subtype).toBe('docx')
    expect(document.sections[0]).toMatchObject({ heading: '第二章 函数', source_anchor: 'heading:第二章 函数' })
    expect(document.content).toContain('函数描述输入与输出之间的关系')
    expect(document.content).toContain('| 参数 | 含义 |')
  })

  it('restores PPTX slides in title-first visual order and records image-only slides as metadata', async () => {
    const fixture = await source('course.pptx', zip({
      '[Content_Types].xml': '<Types/>',
      'ppt/slides/slide1.xml': '<p:sld><p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/></a:xfrm></p:spPr><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><a:t>牛顿第二定律</a:t></p:sp><p:sp><p:spPr><a:xfrm><a:off x="0" y="100"/></a:xfrm></p:spPr><a:t>力、质量与加速度有关。</a:t></p:sp></p:sld>',
      'ppt/media/image1.png': 'not-decoded',
    }))
    const document = await adapter.acquire(fixture.detected, context)
    expect(document.metadata).toMatchObject({ document_subtype: 'pptx', slide_count: 1, image_count: 1 })
    expect(document.sections[0]).toMatchObject({ heading: '牛顿第二定律', source_anchor: 'slide:1' })
    expect(document.sections[0]?.text).toContain('力、质量与加速度有关')
  })

  it('reads XLSX values and formula text without evaluating formulas', async () => {
    const fixture = await source('scores.xlsx', zip({
      '[Content_Types].xml': '<Types/>',
      'xl/workbook.xml': '<workbook><sheets><sheet name="成绩" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>姓名</t></is></c><c r="B1" t="inlineStr"><is><t>分数</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>小明</t></is></c><c r="B2"><v>82</v></c><c r="C2"><f>SUM(B2:B2)</f><v>82</v></c></row></sheetData></worksheet>',
    }))
    const document = await adapter.acquire(fixture.detected, context)
    expect(document.metadata).toMatchObject({ document_subtype: 'xlsx', formula_execution: 'disabled' })
    expect(document.content).toContain('小明')
    expect(document.sections[0]?.source_anchor).toContain('sheet:成绩')
    expect(JSON.stringify(document.metadata)).toContain('formula_count')
  })

  it('denies path traversal, macro documents and manual-path authorization bypasses', async () => {
    expect(() => readOfficeZip(zip({ '../escape.txt': 'no' }))).toThrow('DOCUMENT_ARCHIVE_PATH_DENIED')
    await expect(adapter.inspect({ source_type: 'local_file', source_reference: 'C:\\unsafe\\macro.docm', display_name: 'macro.docm', metadata: {} })).rejects.toThrow('MACRO_DOCUMENT_UNSUPPORTED')
    const fixture = await source('plain.docx', zip({ 'word/document.xml': '<w:document><w:body/></w:document>' }))
    await expect(adapter.inspect({ ...fixture.detected, metadata: { source_mode: 'manual_path' } })).rejects.toThrow('DOCUMENT_INPUT_AUTHORIZATION_REQUIRED')
  })
})
