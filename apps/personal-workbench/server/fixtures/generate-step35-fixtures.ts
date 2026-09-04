/** Generates non-sensitive, local STEP-35 parser fixtures. They are never shipped or uploaded. */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name); const source = Buffer.from(text); const compressed = deflateRawSync(source)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, compressed)
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(8, 10); header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(source.length, 24); header.writeUInt16LE(nameBuffer.length, 28); header.writeUInt32LE(offset, 42)
    central.push(header, nameBuffer); offset += local.length + nameBuffer.length + compressed.length
  }
  const body = Buffer.concat(central); const footer = Buffer.alloc(22); footer.writeUInt32LE(0x06054b50, 0); footer.writeUInt16LE(Object.keys(entries).length, 8); footer.writeUInt16LE(Object.keys(entries).length, 10); footer.writeUInt32LE(body.length, 12); footer.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, body, footer])
}
function textPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/gu, '\\$&')}) Tj ET\n`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'utf8')
}

const root = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'data', 'step35-fixtures'))
await mkdir(root, { recursive: true })
await writeFile(path.join(root, 'STEP35-文本PDF.pdf'), textPdf('Document intelligence local PDF sample'))
await writeFile(path.join(root, 'STEP35-Word讲义.docx'), zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>函数学习资料</w:t></w:r></w:p><w:p><w:r><w:t>函数描述输入和输出的对应关系。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>术语</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>说明</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' }))
await writeFile(path.join(root, 'STEP35-PowerPoint课件.pptx'), zip({ '[Content_Types].xml': '<Types/>', 'ppt/slides/slide1.xml': '<p:sld><p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/></a:xfrm></p:spPr><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><a:t>牛顿第二定律</a:t></p:sp><p:sp><p:spPr><a:xfrm><a:off x="0" y="100"/></a:xfrm></p:spPr><a:t>力、质量与加速度有关。</a:t></p:sp></p:sld>', 'ppt/media/image1.png': 'fixture-image' }))
await writeFile(path.join(root, 'STEP35-Excel资料.xlsx'), zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook><sheets><sheet name="成绩" r:id="rId1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>姓名</t></is></c><c r="B1" t="inlineStr"><is><t>分数</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>小明</t></is></c><c r="B2"><v>82</v></c><c r="C2"><f>SUM(B2:B2)</f><v>82</v></c></row></sheetData></worksheet>' }))
console.log(JSON.stringify({ root }))
