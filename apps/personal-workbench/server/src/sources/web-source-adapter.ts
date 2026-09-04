import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { DetectedKnowledgeSource, KnowledgeSourceAdapterHealth, UnifiedDocumentCodeBlock, UnifiedDocumentRecord, UnifiedDocumentSection } from '../../../shared/contracts/index.ts'
import { assertPublicDnsTarget, fetchPublicHttp, validatePublicHttpUrl } from './safe-http.ts'
import type { KnowledgeSourceAdapter, SourceAdapterContext } from './types.ts'
import { SourceAdapterError } from './types.ts'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom') as { JSDOM: new (html: string, options: { url: string }) => { window: { document: any } } }

const MIN_ARTICLE_CHARS = 280
const MAX_DOCUMENT_CHARS = 420_000
const MAX_CODE_BLOCKS = 80
const JUNK_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'form', 'dialog', 'nav', 'header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[class*="cookie" i]', '[id*="cookie" i]', '[class*="consent" i]', '[id*="consent" i]',
  '[class*="advert" i]', '[id*="advert" i]', '[class*="sidebar" i]', '[id*="sidebar" i]',
].join(',')

function compact(value: string, maximum = 20_000): string {
  return value.replace(/\u00a0/gu, ' ').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim().slice(0, maximum)
}

function meta(document: any, names: string[]): string | null {
  for (const name of names) {
    const node = document.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`)
    const value = node?.getAttribute('content')?.trim()
    if (value !== undefined && value.length > 0) return compact(value, 500)
  }
  return null
}

function readableRoot(document: any): any {
  const explicit = document.querySelector('article, main, [role="main"], .article, .post, .entry-content, .article-content')
  if (explicit !== null && compact(explicit.textContent ?? '').length >= 80) return explicit
  const candidates = [...document.querySelectorAll('section, div')]
    .map(node => ({ node, text: compact(node.textContent ?? ''), paragraphs: node.querySelectorAll('p, li').length }))
    .filter(item => item.text.length >= 80)
    .sort((left, right) => right.text.length + right.paragraphs * 220 - (left.text.length + left.paragraphs * 220))
  return candidates[0]?.node ?? document.body
}

function languageForCode(node: any): string | null {
  const classes = `${node.className} ${node.parentElement?.className ?? ''} ${node.querySelector?.('code')?.className ?? ''}`
  const match = /(?:language-|lang-)([a-z0-9+#.-]{1,32})/iu.exec(classes)
  return match?.[1]?.toLowerCase() ?? null
}

function isLikelyCodeBlock(node: any, text: string): boolean {
  if (node.querySelector?.('code') !== null && node.querySelector?.('code') !== undefined) return true
  if (languageForCode(node) !== null) return true
  // Some standards sites publish their complete article inside a <pre>. Treat a
  // long prose block as article text rather than presenting every page as code.
  if (text.length > 900 && /[.!?。！？]/u.test(text) && /\b(?:the|and|is|are|this|that)\b/iu.test(text)) return false
  return /(?:^|\n)\s*(?:const|let|var|function|class|def|import|from|package|public|private|#include|SELECT|<\/?[A-Za-z][^>]*>|[A-Za-z_][\w.]*\s*\([^\n]*\)\s*\{)/mu.test(text)
}

function anchorFor(node: any, index: number): string {
  const id = node.getAttribute('id')
  return id === null || id.length === 0 ? `section-${index + 1}` : `#${id.slice(0, 160)}`
}

export function normalizeHtmlToUnifiedDocument(input: {
  sourceType: Extract<DetectedKnowledgeSource['source_type'], 'web_url' | 'github_repo'>
  sourceUrl: string
  canonicalUrl: string
  html: string
  contentType: string
  metadata?: Record<string, unknown>
}): Omit<UnifiedDocumentRecord, 'id' | 'task_id' | 'project_id' | 'acquired_at'> {
  const dom = new JSDOM(input.html, { url: input.canonicalUrl })
  const document = dom.window.document
  // Count scripts before removing them. A script-heavy page whose server HTML has
  // no readable body is commonly a client-rendered page, not simply a short article.
  const hadScripts = document.querySelectorAll('script[src], script:not([src])').length > 0
  for (const node of document.querySelectorAll(JUNK_SELECTOR)) node.remove()
  const root = readableRoot(document)
  const title = compact(meta(document, ['og:title', 'twitter:title']) ?? document.title ?? new URL(input.canonicalUrl).hostname, 180)
  const sections: UnifiedDocumentSection[] = []
  const codeBlocks: UnifiedDocumentCodeBlock[] = []
  const content: string[] = []
  let current: UnifiedDocumentSection | null = null
  let sectionIndex = 0
  for (const node of root.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, pre')) {
    const tag = node.tagName.toLowerCase()
    const text = compact(node.textContent ?? '', tag === 'pre' ? 40_000 : 10_000)
    if (text.length === 0) continue
    if (/^h[1-6]$/u.test(tag)) {
      const level = Number(tag[1])
      current = { heading: text, level, text: '', source_anchor: anchorFor(node, sectionIndex) }
      sections.push(current)
      sectionIndex += 1
      content.push(`${'#'.repeat(level)} ${text}`)
      continue
    }
    if (tag === 'pre' && isLikelyCodeBlock(node, text)) {
      const code = text.slice(0, 40_000)
      if (codeBlocks.length < MAX_CODE_BLOCKS) codeBlocks.push({ language: languageForCode(node), content: code, source_anchor: current?.source_anchor ?? anchorFor(node, sectionIndex) })
      content.push(`\`\`\`${languageForCode(node) ?? ''}\n${code}\n\`\`\``)
      continue
    }
    const paragraph = tag === 'li' ? `- ${text}` : text
    if (current === null) {
      current = { heading: '正文', level: 1, text: '', source_anchor: 'content' }
      sections.push(current)
      sectionIndex += 1
    }
    current.text = compact(`${current.text}${current.text.length === 0 ? '' : '\n'}${paragraph}`, 80_000)
    content.push(paragraph)
  }
  const rendered = compact(content.join('\n\n'), MAX_DOCUMENT_CHARS)
  if (sections.length === 0 && rendered.length > 0) {
    sections.push({ heading: '正文', level: 1, text: rendered, source_anchor: 'content' })
  }
  if (rendered.length < MIN_ARTICLE_CHARS) {
    throw new SourceAdapterError(hadScripts ? 'DYNAMIC_PAGE_UNSUPPORTED' : 'CONTENT_TOO_SHORT', hadScripts
      ? '该页面需要浏览器动态加载，当前版本暂时无法直接读取。你可以保存网页、复制正文或等待后续浏览器适配。'
      : '页面可以访问，但没有提取到足够正文。')
  }
  const links = [...root.querySelectorAll('a[href]')]
    .map(node => { try { return new URL(node.getAttribute('href')!, input.canonicalUrl).toString() } catch { return null } })
    .filter((value): value is string => value !== null && /^https?:/iu.test(value))
  const language = document.documentElement.getAttribute('lang')?.trim() || null
  return {
    source_type: input.sourceType,
    source_url: input.sourceUrl,
    canonical_url: input.canonicalUrl,
    title: title || new URL(input.canonicalUrl).hostname,
    author: meta(document, ['author', 'article:author']),
    site_name: meta(document, ['og:site_name']) ?? new URL(input.canonicalUrl).hostname,
    description: meta(document, ['description', 'og:description']), language,
    content_type: input.contentType, content: rendered, sections, code_blocks: codeBlocks,
    links: [...new Set(links)].slice(0, 400), metadata: input.metadata ?? {},
    content_sha256: createHash('sha256').update(rendered, 'utf8').digest('hex'),
  }
}

export class WebSourceAdapter implements KnowledgeSourceAdapter {
  readonly id = 'web' as const

  canHandle(source: DetectedKnowledgeSource): boolean {
    return source.source_type === 'web_url' || source.source_type === 'github_repo' && source.metadata.github_kind !== 'repository'
  }

  async inspect(source: DetectedKnowledgeSource): Promise<Record<string, unknown>> {
    const url = validatePublicHttpUrl(source.source_reference)
    await assertPublicDnsTarget(url)
    return { adapter: this.id, url: url.toString(), public_http: true }
  }

  async acquire(source: DetectedKnowledgeSource, context: SourceAdapterContext): Promise<UnifiedDocumentRecord> {
    context.report({ stage: 'fetching', progress: 16, message: '正在连接公开网页。', tool: '安全网页读取器' })
    const result = await fetchPublicHttp(source.source_reference)
    const contentType = result.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('application/pdf')) throw new SourceAdapterError('DOCUMENT_PDF_PENDING', '这是 PDF 资料，PDF 解析将在文档适配器中处理。')
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new SourceAdapterError('SOURCE_CONTENT_TYPE_UNSUPPORTED', '该链接不是当前可读取的网页正文格式。')
    }
    context.report({ stage: 'processing', progress: 34, message: '正在清理页面导航、脚本和重复区域。', tool: '本机正文提取器' })
    const normalized = normalizeHtmlToUnifiedDocument({
      sourceType: source.source_type === 'github_repo' ? 'github_repo' : 'web_url', sourceUrl: source.source_reference, canonicalUrl: result.url.toString(), html: result.body.toString('utf8'), contentType,
      metadata: { http_status: result.status, redirect_count: result.redirect_count, adapter: this.id, user_instruction: source.metadata.user_instruction ?? null },
    })
    context.report({ stage: 'extracting', progress: 57, message: `正文提取完成，共 ${normalized.sections.length} 个章节。`, tool: '本机正文提取器' })
    return this.toUnifiedDocument(this.normalize({ ...normalized, id: randomUUID(), task_id: context.taskId, project_id: context.projectId, acquired_at: new Date().toISOString() }))
  }

  normalize(document: UnifiedDocumentRecord): UnifiedDocumentRecord { return document }
  toUnifiedDocument(document: UnifiedDocumentRecord): UnifiedDocumentRecord { return document }
  async health(): Promise<KnowledgeSourceAdapterHealth> { return { id: this.id, available: true, detail: '公开 HTTP(S) 页面读取已启用' } }
}
