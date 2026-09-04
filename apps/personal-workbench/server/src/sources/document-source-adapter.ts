import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import type { DetectedKnowledgeSource, KnowledgeSourceAdapterHealth, UnifiedDocumentCodeBlock, UnifiedDocumentRecord, UnifiedDocumentSection } from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { planDocumentChunks } from '../documents/chunk-planner.ts'
import { runProcess } from '../process.ts'
import { SourceAdapterError, type KnowledgeSourceAdapter, type SourceAdapterContext } from './types.ts'

const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx'])
const BLOCKED_OFFICE_EXTENSIONS = new Set(['.doc', '.ppt', '.xls', '.docm', '.dotm'])
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_ZIP_ENTRIES = 12_000
const MAX_ZIP_UNCOMPRESSED_BYTES = 96 * 1024 * 1024
const MAX_ZIP_RATIO = 120
const MAX_PDF_PAGES = 500
const MAX_OCR_PAGES = 40

type ZipEntry = { name: string; value: Buffer }
type DocumentParse = { title: string; content: string; sections: UnifiedDocumentSection[]; codeBlocks: UnifiedDocumentCodeBlock[]; links: string[]; metadata: Record<string, unknown>; contentType: string }

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function compact(value: string, maximum = 48_000): string { return value.replace(/\r\n?/gu, '\n').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim().slice(0, maximum) }
function xmlText(value: string): string {
  if (/<!DOCTYPE|<!ENTITY/iu.test(value)) throw new SourceAdapterError('DOCUMENT_XML_DENIED', '文档结构包含不受支持的外部实体，已经停止读取。')
  return compact(value.replace(/<[^>]+>/gu, ' ').replace(/&(?:amp|lt|gt|quot|apos);/gu, item => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[item] ?? item).replace(/_x([0-9A-F]{4})_/giu, (_item, code: string) => String.fromCharCode(Number.parseInt(code, 16))))
}
function xmlAttribute(value: string, name: string): string | null {
  // Attribute names are fixed OOXML names controlled by this module (for example r:id and Target).
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(value)
  return match?.[1] ?? null
}
function safeZipName(name: string): void {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').includes('..') || normalized.includes('\0')) throw new SourceAdapterError('DOCUMENT_ARCHIVE_PATH_DENIED', '文档内部路径无效，已经停止读取。')
}

/** Small, read-only ZIP reader for OOXML containers. It never extracts entries to disk. */
export function readOfficeZip(buffer: Buffer): Map<string, Buffer> {
  if (buffer.length < 22) throw new SourceAdapterError('DOCUMENT_ARCHIVE_INVALID', '文档文件不完整或不是可读取的 Office 文件。')
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const start = Math.max(0, buffer.length - 65_557)
  const eocdOffset = buffer.lastIndexOf(eocd, buffer.length - 22)
  if (eocdOffset < start) throw new SourceAdapterError('DOCUMENT_ARCHIVE_INVALID', '文档文件不完整或不是可读取的 Office 文件。')
  const entries = buffer.readUInt16LE(eocdOffset + 10)
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (entries > MAX_ZIP_ENTRIES || centralOffset >= buffer.length) throw new SourceAdapterError('DOCUMENT_ARCHIVE_LIMIT', '文档包含过多内部文件，当前版本没有继续读取。')
  const output = new Map<string, Buffer>()
  let cursor = centralOffset
  let uncompressedTotal = 0
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new SourceAdapterError('DOCUMENT_ARCHIVE_INVALID', '文档压缩结构无效。')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressed = buffer.readUInt32LE(cursor + 20)
    const uncompressed = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    if ((flags & 0x1) !== 0) throw new SourceAdapterError('PASSWORD_PROTECTED_DOCUMENT', '该文档受到密码保护，当前版本无法读取。')
    if (nameLength === 0 || cursor + 46 + nameLength + extraLength + commentLength > buffer.length || localOffset + 30 > buffer.length) throw new SourceAdapterError('DOCUMENT_ARCHIVE_INVALID', '文档压缩结构无效。')
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    safeZipName(name)
    if (uncompressed > MAX_ZIP_UNCOMPRESSED_BYTES || (compressed > 0 && uncompressed / compressed > MAX_ZIP_RATIO)) throw new SourceAdapterError('DOCUMENT_ARCHIVE_LIMIT', '文档解压后体积异常，已经停止读取。')
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new SourceAdapterError('DOCUMENT_ARCHIVE_INVALID', '文档本地压缩结构无效。')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressed > buffer.length) throw new SourceAdapterError('DOCUMENT_ARCHIVE_INVALID', '文档数据范围无效。')
    let value: Buffer
    try { value = method === 0 ? Buffer.from(buffer.subarray(dataOffset, dataOffset + compressed)) : method === 8 ? inflateRawSync(buffer.subarray(dataOffset, dataOffset + compressed)) : (() => { throw new Error('unsupported') })() } catch { throw new SourceAdapterError('DOCUMENT_ARCHIVE_UNSUPPORTED', '文档使用了当前版本不支持的压缩方式。') }
    if (value.length !== uncompressed || value.length > MAX_ZIP_UNCOMPRESSED_BYTES) throw new SourceAdapterError('DOCUMENT_ARCHIVE_LIMIT', '文档解压结果异常，已经停止读取。')
    uncompressedTotal += value.length
    if (uncompressedTotal > MAX_ZIP_UNCOMPRESSED_BYTES) throw new SourceAdapterError('DOCUMENT_ARCHIVE_LIMIT', '文档解压后的总大小超过当前安全限制。')
    output.set(name, value)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return output
}

function entryText(entries: Map<string, Buffer>, name: string): string {
  const value = entries.get(name)
  if (value === undefined) throw new SourceAdapterError('DOCUMENT_STRUCTURE_MISSING', '文档缺少必要的内容结构。')
  const text = value.toString('utf8')
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new SourceAdapterError('DOCUMENT_XML_DENIED', '文档结构包含不受支持的外部实体，已经停止读取。')
  return text
}
function headingLevel(style: string): number | null {
  const match = /(?:heading|标题)\s*([1-9])/iu.exec(style)
  return match === null ? null : Number(match[1])
}
function parseDocx(buffer: Buffer, name: string): DocumentParse {
  const entries = readOfficeZip(buffer)
  const xml = entryText(entries, 'word/document.xml')
  const sections: UnifiedDocumentSection[] = []
  const blocks = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gu)]
  let current: UnifiedDocumentSection | null = null
  const preface: string[] = []
  for (const [index, item] of blocks.entries()) {
    const raw = item[0]
    const text = xmlText(raw.replace(/<w:tab\s*\/?\s*>/gu, '\t').replace(/<w:br\s*\/?\s*>/gu, '\n'))
    if (text.length === 0) continue
    const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/u.exec(raw)?.[1] ?? ''
    const level = headingLevel(style)
    if (level !== null) {
      current = { heading: text.slice(0, 180), level, text: '', source_anchor: `heading:${text.slice(0, 120)}` }
      sections.push(current)
    } else if (current !== null) current.text = compact(`${current.text}\n${text}`, 36_000)
    else preface.push(text)
    if (index > 20_000) throw new SourceAdapterError('DOCUMENT_ARCHIVE_LIMIT', '文档段落数量超过当前安全限制。')
  }
  const tables = [...xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/gu)].map((table, tableIndex) => {
    const rows = [...table[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/gu)].map(row => [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/gu)].map(cell => xmlText(cell[0])))
    return rows.filter(row => row.length > 0)
  }).filter(rows => rows.length > 0)
  const tableText = tables.map(rows => rows.map(row => `| ${row.join(' | ')} |`).join('\n')).join('\n\n')
  if (sections.length === 0) sections.push({ heading: '文档内容', level: 1, text: compact([...preface, tableText].filter(Boolean).join('\n\n')), source_anchor: 'document' })
  else if (tableText.length > 0) sections.push({ heading: '文档表格', level: 2, text: tableText, source_anchor: 'tables' })
  const content = compact(sections.map(section => `${'#'.repeat(Math.min(6, Math.max(1, section.level)))} ${section.heading}\n\n${section.text}`).join('\n\n'), 420_000)
  return { title: path.basename(name, '.docx'), content, sections, codeBlocks: [], links: [], contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', metadata: { document_subtype: 'docx', table_count: tables.length, image_count: [...entries.keys()].filter(key => key.startsWith('word/media/')).length, text_source: 'docx_xml' } }
}
function parsePptx(buffer: Buffer, name: string): DocumentParse {
  const entries = readOfficeZip(buffer)
  const slideNames = [...entries.keys()].filter(key => /^ppt\/slides\/slide\d+\.xml$/u.test(key)).sort((left, right) => Number(/\d+/u.exec(left)?.[0]) - Number(/\d+/u.exec(right)?.[0]))
  if (slideNames.length === 0) throw new SourceAdapterError('DOCUMENT_STRUCTURE_MISSING', '课件没有可读取的页面。')
  const sections: UnifiedDocumentSection[] = []
  let tableCount = 0
  for (const [index, slideName] of slideNames.entries()) {
    const xml = entryText(entries, slideName)
    const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gu)].map(raw => {
      const offset = /<a:off\b[^>]*x="(\d+)"[^>]*y="(\d+)"/u.exec(raw[0])
      return { text: xmlText(raw[0]), x: Number(offset?.[1] ?? 0), y: Number(offset?.[2] ?? 0), title: /<p:ph\b[^>]*type="title"/u.test(raw[0]) }
    }).filter(shape => shape.text.length > 0).sort((a, b) => a.y - b.y || a.x - b.x)
    const title = shapes.find(shape => shape.title)?.text ?? shapes[0]?.text ?? `第 ${index + 1} 页课件`
    const tables = [...xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/gu)].map(table => [...table[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/gu)].map(row => [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/gu)].map(cell => xmlText(cell[0]))).filter(row => row.length > 0)).filter(rows => rows.length > 0)
    tableCount += tables.length
    const body = [shapes.map(shape => shape.text).filter(text => text !== title).join('\n'), ...tables.map(rows => rows.map(row => `| ${row.join(' | ')} |`).join('\n'))].filter(Boolean).join('\n\n')
    sections.push({ heading: title.slice(0, 180), level: 1, text: compact(body), source_anchor: `slide:${index + 1}` })
  }
  const content = compact(sections.map(section => `# ${section.heading}\n\n${section.text}`).join('\n\n'), 420_000)
  return { title: path.basename(name, '.pptx'), content, sections, codeBlocks: [], links: [], contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', metadata: { document_subtype: 'pptx', slide_count: sections.length, table_count: tableCount, image_count: [...entries.keys()].filter(key => key.startsWith('ppt/media/')).length, text_source: 'pptx_xml' } }
}
function excelColumn(cell: string): string { return /^[A-Z]+/u.exec(cell)?.[0] ?? '' }
function columnNumber(name: string): number { return [...name].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) }
function parseXlsx(buffer: Buffer, name: string): DocumentParse {
  const entries = readOfficeZip(buffer)
  const shared = entries.get('xl/sharedStrings.xml')
  const sharedStrings = shared === undefined ? [] : [...entryText(entries, 'xl/sharedStrings.xml').matchAll(/<si\b[\s\S]*?<\/si>/gu)].map(item => xmlText(item[0]))
  const workbook = entryText(entries, 'xl/workbook.xml')
  const rels = entryText(entries, 'xl/_rels/workbook.xml.rels')
  const relationship = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gu)].map(item => [xmlAttribute(item[1]!, 'Id') ?? '', xmlAttribute(item[1]!, 'Target') ?? '']))
  const sheetRows = [...workbook.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/gu)]
  const sections: UnifiedDocumentSection[] = []
  const summaries: Record<string, unknown>[] = []
  for (const [sheetIndex, sheet] of sheetRows.entries()) {
    const attrs = sheet[1]!
    const sheetName = xmlAttribute(attrs, 'name') ?? `Sheet ${sheetIndex + 1}`
    const rid = xmlAttribute(attrs, 'r:id') ?? ''
    const target = relationship.get(rid)?.replace(/^\//u, '').replace(/^xl\//u, '')
    const xmlName = target === undefined ? `xl/worksheets/sheet${sheetIndex + 1}.xml` : `xl/${target}`
    const xml = entryText(entries, xmlName)
    const values = new Map<string, { text: string; formula: string | null }>()
    for (const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)) {
      const attrsCell = cell[1]!
      const body = cell[2]!
      const reference = xmlAttribute(attrsCell, 'r') ?? ''
      const type = xmlAttribute(attrsCell, 't')
      const raw = /<v>([\s\S]*?)<\/v>/u.exec(body)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/u.exec(body)?.[1] ?? ''
      const formula = /<f[^>]*>([\s\S]*?)<\/f>/u.exec(body)?.[1] ?? null
      const text = type === 's' ? (sharedStrings[Number(raw)] ?? '') : xmlText(raw)
      if (reference.length > 0) values.set(reference, { text, formula: formula === null ? null : `=${xmlText(formula)}` })
    }
    const rows = new Map<number, Map<string, { text: string; formula: string | null }>>()
    for (const [reference, value] of values) {
      const row = Number(/\d+$/u.exec(reference)?.[0] ?? 0); const column = excelColumn(reference)
      if (row < 1 || column.length === 0) continue
      const targetRow = rows.get(row) ?? new Map(); targetRow.set(column, value); rows.set(row, targetRow)
    }
    const columns = [...new Set([...values.keys()].map(excelColumn))].sort((a, b) => columnNumber(a) - columnNumber(b))
    const shownRows = [...rows.entries()].sort(([a], [b]) => a - b).slice(0, 200)
    const table = shownRows.map(([row, cells]) => `| ${columns.map(column => cells.get(column)?.text ?? '').join(' | ')} |`).join('\n')
    const numeric = columns.map(column => [...rows.values()].map(row => Number(row.get(column)?.text)).filter(Number.isFinite)).filter(values => values.length > 0).map(values => ({ count: values.length, min: Math.min(...values), max: Math.max(...values), mean: Number((values.reduce((sum, item) => sum + item, 0) / values.length).toFixed(4)) }))
    const formulaCount = [...values.values()].filter(value => value.formula !== null).length
    const usedRows = rows.size; const usedColumns = columns.length
    summaries.push({ sheet: sheetName, used_rows: usedRows, used_columns: usedColumns, formula_count: formulaCount, numeric_column_stats: numeric, computed_by: 'workbench_local' })
    sections.push({ heading: sheetName, level: 1, text: compact(`工作表范围：${usedRows} 行 × ${usedColumns} 列。\n公式单元格：${formulaCount}（仅保留公式文本，未执行）。\n\n${table}`), source_anchor: `sheet:${sheetName};range:A1:${columns.at(-1) ?? 'A'}${shownRows.at(-1)?.[0] ?? 1}` })
  }
  if (sections.length === 0) throw new SourceAdapterError('DOCUMENT_STRUCTURE_MISSING', 'Excel 文件没有可读取的工作表。')
  return { title: path.basename(name, '.xlsx'), content: compact(sections.map(section => `# ${section.heading}\n\n${section.text}`).join('\n\n'), 420_000), sections, codeBlocks: [], links: [], contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', metadata: { document_subtype: 'xlsx', workbook: { sheet_count: sections.length }, sheets: summaries, formula_execution: 'disabled', text_source: 'xlsx_xml' } }
}
function executable(name: string): string | null {
  const file = process.platform === 'win32' ? `${name}.exe` : name
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/gu, ''), file)).find(existsSync) ?? null
}

async function extractPdfJsPages(filePath: string): Promise<string[]> {
  const packagedModules = process.env.PERSONAL_WORKBENCH_APP_NODE_MODULES
  const pdfModule = packagedModules === undefined
    ? 'pdfjs-dist/legacy/build/pdf.mjs'
    : pathToFileURL(path.join(packagedModules, 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href
  const pdfjs = await import(pdfModule) as typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    useSystemFonts: true,
    disableFontFace: true,
  })
  let document: Awaited<typeof task.promise> | null = null
  try {
    document = await task.promise
    if (document.numPages > MAX_PDF_PAGES) throw new SourceAdapterError('PDF_PAGE_LIMIT', '文档页数超过当前版本的安全限制，请按章节分批导入。')
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent({ includeMarkedContent: false })
      const positioned = content.items.flatMap(item => {
        const value = item as { str?: string; transform?: number[]; hasEOL?: boolean }
        if (typeof value.str !== 'string' || value.str.trim().length === 0) return []
        return [{ text: value.str, x: Number(value.transform?.[4] ?? 0), y: Number(value.transform?.[5] ?? 0), eol: value.hasEOL === true }]
      })
      const lines: Array<{ y: number; items: typeof positioned }> = []
      for (const item of positioned.sort((a, b) => b.y - a.y || a.x - b.x)) {
        const line = lines.find(candidate => Math.abs(candidate.y - item.y) <= 2)
        if (line === undefined) lines.push({ y: item.y, items: [item] })
        else line.items.push(item)
      }
      pages.push(compact(lines.sort((a, b) => b.y - a.y).map(line => line.items.sort((a, b) => a.x - b.x).map(item => item.text).join(' ')).join('\n'), 42_000))
      page.cleanup()
    }
    return pages
  } catch (error) {
    if (/password|encrypted/iu.test(error instanceof Error ? error.message : String(error))) throw new SourceAdapterError('PASSWORD_PROTECTED_DOCUMENT', '该文档受到密码保护，当前版本无法读取。')
    throw error
  } finally {
    await task.destroy().catch(() => undefined)
  }
}

export class DocumentSourceAdapter implements KnowledgeSourceAdapter {
  readonly id = 'document' as const
  canHandle(source: DetectedKnowledgeSource): boolean { return source.source_type === 'local_file' && DOCUMENT_EXTENSIONS.has(path.extname(source.source_reference).toLowerCase()) }
  async inspect(source: DetectedKnowledgeSource): Promise<Record<string, unknown>> {
    const suffix = path.extname(source.source_reference).toLowerCase()
    if (BLOCKED_OFFICE_EXTENSIONS.has(suffix)) throw new SourceAdapterError(suffix.endsWith('m') ? 'MACRO_DOCUMENT_UNSUPPORTED' : 'LEGACY_OFFICE_DOCUMENT_UNSUPPORTED', suffix.endsWith('m') ? '当前版本暂不处理包含宏的 Word 文件。' : '这是旧版 Office 格式，请先另存为 DOCX、PPTX 或 XLSX 后导入。')
    if (!DOCUMENT_EXTENSIONS.has(suffix)) throw new SourceAdapterError('DOCUMENT_FORMAT_UNSUPPORTED', '当前文件格式不属于可读取的 PDF、Word、PowerPoint 或 Excel。')
    if (typeof source.metadata.input_asset_id !== 'string' || !['native_picker', 'drag_drop', 'project'].includes(String(source.metadata.source_mode))) throw new SourceAdapterError('DOCUMENT_INPUT_AUTHORIZATION_REQUIRED', '请通过系统文件选择窗口或导入副本后再读取该文档。')
    const sourcePath = path.resolve(source.source_reference)
    const info = await import('node:fs/promises').then(fs => fs.stat(sourcePath)).catch(() => null)
    if (info === null || !info.isFile()) throw new SourceAdapterError('DOCUMENT_FILE_UNAVAILABLE', '当前文档已经不可访问，请重新选择文件。')
    if (info.size > MAX_FILE_BYTES) throw new SourceAdapterError('DOCUMENT_FILE_TOO_LARGE', '文档较大，超过当前版本的单文件安全读取限制。')
    return { adapter: this.id, document_subtype: suffix.slice(1), size_bytes: info.size, pdf_text_tool: suffix === '.pdf' ? executable('pdftotext') ?? 'pdfjs-dist' : null }
  }
  async acquire(source: DetectedKnowledgeSource, context: SourceAdapterContext): Promise<UnifiedDocumentRecord> {
    const inspected = await this.inspect(source)
    const suffix = path.extname(source.source_reference).toLowerCase()
    context.report({ stage: 'fetching', progress: 16, message: suffix === '.pdf' ? '正在读取 PDF 文档。' : suffix === '.pptx' ? '正在整理 PowerPoint 课件。' : suffix === '.xlsx' ? '正在读取 Excel 工作表。' : '正在读取 Word 文档。', tool: '本机只读文档解析器' })
    const body = suffix === '.pdf' ? await this.parsePdf(source.source_reference, context, String(inspected.pdf_text_tool ?? '')) : this.parseOffice(await readFile(source.source_reference), suffix, source.display_name)
    context.report({ stage: 'extracting', progress: 61, message: `内容结构已恢复，共 ${body.sections.length} 个章节。`, tool: '本机只读文档解析器' })
    const canonical = `local-document:${sha256(path.resolve(source.source_reference))}`
    const chunks = planDocumentChunks(body.sections)
    return { id: randomUUID(), task_id: context.taskId, project_id: context.projectId, source_type: 'local_file', source_url: source.display_name, canonical_url: canonical, title: body.title, author: null, site_name: '本机文档', description: null, language: null, content_type: body.contentType, content: body.content, sections: body.sections, code_blocks: body.codeBlocks, links: body.links, metadata: { ...body.metadata, adapter: this.id, input_asset_id: source.metadata.input_asset_id, source_mode: source.metadata.source_mode, size_bytes: inspected.size_bytes, chunk_plan: { strategy: 'section/page/sheet', maximum_chars: 12_000, chunks: chunks.map(chunk => ({ index: chunk.index, anchors: chunk.anchors, chars: chunk.char_count })) } }, acquired_at: new Date().toISOString(), content_sha256: sha256(body.content) }
  }
  normalize(document: UnifiedDocumentRecord): UnifiedDocumentRecord { return document }
  toUnifiedDocument(document: UnifiedDocumentRecord): UnifiedDocumentRecord { return document }
  async health(): Promise<KnowledgeSourceAdapterHealth> { return { id: this.id, available: true, detail: executable('pdftotext') === null ? 'Office 文档解析可用；未检测到 PDF 原生文本工具。' : 'PDF 与 Office 文档本机只读解析可用。' } }
  private parseOffice(buffer: Buffer, suffix: string, name: string): DocumentParse {
    if (buffer.length > MAX_FILE_BYTES) throw new SourceAdapterError('DOCUMENT_FILE_TOO_LARGE', '文档超过当前版本的单文件安全读取限制。')
    if (suffix === '.docx') return parseDocx(buffer, name)
    if (suffix === '.pptx') return parsePptx(buffer, name)
    if (suffix === '.xlsx') return parseXlsx(buffer, name)
    throw new SourceAdapterError('DOCUMENT_FORMAT_UNSUPPORTED', '当前文件格式不能由本机文档解析器读取。')
  }
  private async parsePdf(filePath: string, context: SourceAdapterContext, pdfTextExecutable: string): Promise<DocumentParse> {
    let pages: string[]
    let pdfTextRuntime: string
    if (path.isAbsolute(pdfTextExecutable) && existsSync(pdfTextExecutable)) {
      const extracted = await runProcess(pdfTextExecutable, ['-enc', 'UTF-8', '-layout', filePath, '-'], { timeoutMs: 120_000 })
      if (extracted.exitCode !== 0 || extracted.timedOut) {
        if (/password|encrypted|incorrect password/iu.test(`${extracted.stderr} ${extracted.stdout}`)) throw new SourceAdapterError('PASSWORD_PROTECTED_DOCUMENT', '该文档受到密码保护，当前版本无法读取。')
        throw new SourceAdapterError('PDF_TEXT_EXTRACTION_FAILED', '无法读取 PDF 原生文字，文档可能损坏或受到保护。')
      }
      pages = extracted.stdout.split('\f').map(text => compact(text, 42_000)).filter((text, index, values) => text.length > 0 || index < values.length - 1)
      pdfTextRuntime = 'pdftotext'
    } else {
      try { pages = await extractPdfJsPages(filePath); pdfTextRuntime = 'pdfjs-dist' }
      catch (error) {
        if (error instanceof SourceAdapterError) throw error
        throw new SourceAdapterError('PDF_TEXT_EXTRACTION_FAILED', `无法读取 PDF 原生文字：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (pages.length > MAX_PDF_PAGES) throw new SourceAdapterError('PDF_PAGE_LIMIT', '文档页数超过当前版本的安全限制，请按章节分批导入。')
    const sections: UnifiedDocumentSection[] = pages.map((text, index) => ({ heading: `第 ${index + 1} 页`, level: 1, text: text.length > 0 ? text : '本页没有可提取的原生文本。', source_anchor: `page:${index + 1}` }))
    const sparse = sections.filter(section => section.text.length < 30)
    if (sparse.length > 0) {
      context.report({ stage: 'processing', progress: 38, message: `发现 ${sparse.length} 个扫描或文字较少的页面，正在按需进行本机 OCR。`, tool: '本机 PDF OCR' })
      const corrections = await this.ocrPdfPages(filePath, context.taskId, sparse.map(section => Number(/\d+/u.exec(section.source_anchor)?.[0])), Math.min(MAX_OCR_PAGES, sparse.length))
      for (const [page, text] of corrections) {
        const section = sections[page - 1]
        if (section !== undefined && text.length > 0) section.text = text
      }
    }
    const textSource = sparse.length === 0 ? 'native_pdf' : sparse.length >= pages.length ? 'ocr' : 'mixed'
    const content = compact(sections.map(section => `# ${section.heading}\n\n${section.text}`).join('\n\n'), 420_000)
    return { title: path.basename(filePath, '.pdf'), content, sections, codeBlocks: [], links: [], contentType: 'application/pdf', metadata: { document_subtype: 'pdf', page_count: sections.length, text_source: textSource, pdf_text_runtime: pdfTextRuntime, native_text_pages: pages.length - sparse.length, ocr_requested_pages: sparse.length, ocr_page_limit: MAX_OCR_PAGES } }
  }
  private async ocrPdfPages(filePath: string, taskId: string, pageNumbers: number[], take: number): Promise<Map<number, string>> {
    const renderer = executable('pdftoppm')
    if (renderer === null || PATHS.asrPython === null || !existsSync(PATHS.asrPython)) return new Map()
    const root = path.join(PATHS.dataRoot, 'runtime', 'documents', taskId)
    const pagesRoot = path.join(root, 'pages')
    await mkdir(pagesRoot, { recursive: true })
    const selected = pageNumbers.slice(0, take)
    for (const page of selected) {
      const prefix = path.join(pagesRoot, `page-${page}`)
      const rendered = await runProcess(renderer, ['-f', String(page), '-l', String(page), '-png', '-r', '150', filePath, prefix], { timeoutMs: 120_000 })
      if (rendered.exitCode !== 0 || rendered.timedOut) continue
    }
    const files = (await readdir(pagesRoot)).filter(name => /^page-\d+-\d+\.png$/u.test(name)).sort()
    if (files.length === 0) return new Map()
    const manifest = path.join(root, 'pdf-ocr-manifest.json'); const output = path.join(root, 'pdf-ocr-results.json')
    await writeFile(manifest, `${JSON.stringify({ frames: files.map((file, index) => ({ index, file, timestamp_ms: 0 })) })}\n`, { encoding: 'utf8', flag: 'w' })
    const worker = path.join(PATHS.appRoot, 'server', 'workers', 'ocr.py')
    const result = await runProcess(PATHS.asrPython, [worker, '--input-dir', pagesRoot, '--manifest', manifest, '--output', output], { cwd: root, timeoutMs: 20 * 60_000 }).catch(() => null)
    if (result === null || result.exitCode !== 0) return new Map()
    const outputBody = JSON.parse(await readFile(output, 'utf8')) as { frames?: Array<{ index?: number; text?: string }> }
    const mapped = new Map<number, string>()
    for (const frame of outputBody.frames ?? []) {
      const file = files[Number(frame.index)]
      const page = Number(/^page-(\d+)-/u.exec(file ?? '')?.[1] ?? 0)
      if (page > 0 && typeof frame.text === 'string') mapped.set(page, compact(frame.text, 32_000))
    }
    return mapped
  }
}
