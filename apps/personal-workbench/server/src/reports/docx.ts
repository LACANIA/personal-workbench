import { deflateRawSync, inflateRawSync } from 'node:zlib'

interface ZipEntry {
  name: string
  data: Buffer
}

interface MarkdownBlock {
  kind: 'heading' | 'paragraph' | 'code' | 'formula' | 'bullet' | 'numbered' | 'table'
  level?: number
  text?: string
  rows?: string[][]
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) === 1 ? 0xedb88320 : 0)
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let value = 0xffffffff
  for (const byte of data) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]!
  return (value ^ 0xffffffff) >>> 0
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!)
}

function zip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = deflateRawSync(entry.data)
    const crc = crc32(entry.data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(entry.data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    const localRecord = Buffer.concat([localHeader, name, compressed])
    local.push(localRecord)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(entry.data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([centralHeader, name]))
    offset += localRecord.length
  }
  const centralDirectory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralDirectory, end])
}

function markdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) { index += 1; continue }
    if (line.startsWith('```')) {
      // Models occasionally place an entire fenced snippet on one line. Treat it
      // as code immediately, so it cannot absorb every following heading/table.
      if (line.length > 6 && line.endsWith('```')) {
        blocks.push({ kind: 'code', text: line.slice(3, -3).trim() })
        index += 1
        continue
      }
      const language = line.slice(3).trim()
      const code: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) { code.push(lines[index] ?? ''); index += 1 }
      if (index < lines.length) index += 1
      blocks.push({ kind: 'code', text: `${language.length > 0 ? `${language}\n` : ''}${code.join('\n')}` })
      continue
    }
    const formula = /^\$\$(.+)\$\$$/u.exec(line.trim())
    if (formula !== null) { blocks.push({ kind: 'formula', text: formula[1]!.trim() }); index += 1; continue }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
    if (heading !== null) { blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() }); index += 1; continue }
    if (/^\|.*\|\s*$/u.test(line) && index + 1 < lines.length && /^\|?\s*:?-{3,}/u.test(lines[index + 1] ?? '')) {
      const rows: string[] = [line]
      let rowIndex = index + 2
      while (rowIndex < lines.length && /^\|.*\|\s*$/u.test(lines[rowIndex] ?? '')) { rows.push(lines[rowIndex] ?? ''); rowIndex += 1 }
      blocks.push({ kind: 'table', rows: rows.map(row => row.split('|').slice(1, -1).map(cell => cell.trim())) })
      index = rowIndex
      continue
    }
    const bullet = /^[-*+]\s+(.+)$/u.exec(line)
    if (bullet !== null) { blocks.push({ kind: 'bullet', text: bullet[1]!.trim() }); index += 1; continue }
    const numbered = /^\d+[.)]\s+(.+)$/u.exec(line)
    if (numbered !== null) { blocks.push({ kind: 'numbered', text: numbered[1]!.trim() }); index += 1; continue }
    const paragraph: string[] = [line.trim()]
    index += 1
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (next.trim().length === 0 || /^#{1,6}\s+/u.test(next) || next.startsWith('```') || /^\$\$.+\$\$$/u.test(next.trim()) || /^[-*+]\s+/u.test(next) || /^\d+[.)]\s+/u.test(next) || /^\|.*\|\s*$/u.test(next)) break
      paragraph.push(next.trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
  }
  return blocks
}

function run(text: string, properties = ''): string {
  const parts = text.split('\n')
  return `<w:r>${properties}${parts.map((part, index) => `${index === 0 ? '' : '<w:br/>'}<w:t xml:space="preserve">${escapeXml(part)}</w:t>`).join('')}</w:r>`
}

function paragraph(text: string, style?: string, properties = '', paragraphProperties = ''): string {
  const ppr = style === undefined && paragraphProperties.length === 0 ? '' : `<w:pPr>${style === undefined ? '' : `<w:pStyle w:val="${style}"/>`}${paragraphProperties}</w:pPr>`
  return `<w:p>${ppr}${run(text, properties)}</w:p>`
}

function table(rows: string[][]): string {
  const columns = Math.max(1, ...rows.map(row => row.length))
  const widths = Array.from({ length: columns }, () => Math.floor(9026 / columns))
  widths[widths.length - 1]! += 9026 - widths.reduce((sum, width) => sum + width, 0)
  const body = rows.map((row, rowIndex) => `<w:tr>${widths.map((width, columnIndex) => {
    const cell = row[columnIndex] ?? ''
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr>${paragraph(cell, rowIndex === 0 ? 'TableHeader' : undefined)}</w:tc>`
  }).join('')}</w:tr>`).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="9026" w:type="dxa"/><w:tblInd w:w="120" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B8C5DD"/><w:left w:val="single" w:sz="4" w:color="B8C5DD"/><w:bottom w:val="single" w:sz="4" w:color="B8C5DD"/><w:right w:val="single" w:sz="4" w:color="B8C5DD"/><w:insideH w:val="single" w:sz="2" w:color="D8E0EF"/><w:insideV w:val="single" w:sz="2" w:color="D8E0EF"/></w:tblBorders></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${body}</w:tbl>`
}

function pageBreak(): string { return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' }

function listParagraph(text: string, numId: number): string {
  return paragraph(text, undefined, '', `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr><w:spacing w:after="90"/>`)
}

function documentXml(markdown: string, title: string): string {
  const blocks = markdownBlocks(markdown)
  const body: string[] = [paragraph(title, 'Title')]
  const headings = blocks.filter(block => block.kind === 'heading' && (block.level ?? 1) <= 3)
  const firstHeading = blocks.findIndex(block => block.kind === 'heading')
  const preamble = firstHeading < 0 ? [] : blocks.slice(0, firstHeading)
  const main = firstHeading < 0 ? blocks : blocks.slice(firstHeading)
  for (const block of preamble) {
    if (block.kind === 'paragraph') body.push(paragraph(block.text ?? '', undefined, '', '<w:spacing w:after="120"/>'))
    else if (block.kind === 'table') body.push(table(block.rows ?? []))
  }
  if (headings.length > 0) {
    body.push(pageBreak())
    body.push(paragraph('目录', 'Heading1'))
    body.push('<w:p><w:fldSimple w:instr="TOC \\o &quot;1-3&quot; \\h \\z \\u"><w:r><w:t>打开 Word 后可更新目录。</w:t></w:r></w:fldSimple></w:p>')
    body.push(pageBreak())
  }
  for (const block of main) {
    if (block.kind === 'heading') body.push(paragraph(block.text ?? '', `Heading${Math.min(3, block.level ?? 1)}`))
    else if (block.kind === 'paragraph') body.push(paragraph(block.text ?? ''))
    else if (block.kind === 'bullet') body.push(listParagraph(block.text ?? '', 1))
    else if (block.kind === 'numbered') body.push(listParagraph(block.text ?? '', 2))
    else if (block.kind === 'code') body.push(paragraph(block.text ?? '', 'Code', '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F2F4F7"/></w:rPr>'))
    else if (block.kind === 'formula') body.push(paragraph(block.text ?? '', 'Formula'))
    else if (block.kind === 'table') body.push(table(block.rows ?? []))
  }
  body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/><w:footerReference w:type="default" r:id="rId3"/></w:sectPr>')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${body.join('')}</w:document>`
}

function stylesXml(): string {
  const font = '<w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/>'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="22"/><w:lang w:val="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr>${font}</w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="300"/></w:pPr><w:rPr>${font}<w:b/><w:color w:val="1F3B68"/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="300" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr>${font}<w:b/><w:color w:val="2457A6"/><w:sz w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="220" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr>${font}<w:b/><w:color w:val="314F7A"/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:spacing w:before="160" w:after="90"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr>${font}<w:b/><w:color w:val="425C82"/><w:sz w:val="23"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:pPr><w:spacing w:before="80" w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Formula"><w:name w:val="Formula"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math" w:eastAsia="Microsoft YaHei"/><w:color w:val="1F3B68"/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:rPr>${font}<w:b/><w:color w:val="1F3B68"/></w:rPr></w:style></w:styles>`
}

function numberingXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>'
}

function footerXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>第 </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t> 页</w:t></w:r></w:p></w:ftr>'
}

/** 仅使用 Node 标准库生成基础 DOCX，避免在本地工作台引入额外运行依赖。 */
export function createDocxFromMarkdown(markdown: string, title: string): Buffer {
  const safeTitle = title.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 160) || 'Personal Workbench 报告'
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml(), 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(numberingXml(), 'utf8') },
    { name: 'word/footer1.xml', data: Buffer.from(footerXml(), 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(markdown, safeTitle), 'utf8') },
  ]
  return zip(entries)
}

/** 用于写入前自检，确保输出具有完整 Office Open XML 基础结构。 */
export function validateDocx(buffer: Buffer): void {
  const names: string[] = []
  let index = 0
  while (index + 30 <= buffer.length && buffer.readUInt32LE(index) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(index + 18)
    const nameLength = buffer.readUInt16LE(index + 26)
    const extraLength = buffer.readUInt16LE(index + 28)
    const name = buffer.subarray(index + 30, index + 30 + nameLength).toString('utf8')
    names.push(name)
    index += 30 + nameLength + extraLength + compressedSize
  }
  if (!['[Content_Types].xml', 'word/document.xml', 'word/styles.xml'].every(name => names.includes(name))) throw new Error('DOCX_VALIDATION_FAILED')
}

export function readDocxDocumentXml(buffer: Buffer): string {
  let index = 0
  while (index + 30 <= buffer.length && buffer.readUInt32LE(index) === 0x04034b50) {
    const compression = buffer.readUInt16LE(index + 8)
    const compressedSize = buffer.readUInt32LE(index + 18)
    const nameLength = buffer.readUInt16LE(index + 26)
    const extraLength = buffer.readUInt16LE(index + 28)
    const start = index + 30 + nameLength + extraLength
    const name = buffer.subarray(index + 30, index + 30 + nameLength).toString('utf8')
    if (name === 'word/document.xml') {
      const data = buffer.subarray(start, start + compressedSize)
      return (compression === 8 ? inflateRawSync(data) : data).toString('utf8')
    }
    index = start + compressedSize
  }
  throw new Error('DOCX_DOCUMENT_XML_MISSING')
}
