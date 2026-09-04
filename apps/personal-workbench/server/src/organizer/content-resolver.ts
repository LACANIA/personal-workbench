import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DetectedKnowledgeSource } from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { runProcess } from '../process.ts'
import { DocumentSourceAdapter } from '../sources/document-source-adapter.ts'

export interface OrganizerDocumentProfile {
  source_file: string
  document_type: 'pdf' | 'docx' | 'pptx' | 'xlsx'
  title: string
  summary: string
  keywords: string[]
  topic: string | null
  source_anchors: string[]
  content_hash: string
  category: '学习资料' | '数据'
  reason: string
}

const DOCUMENT_TYPES = new Set(['pdf', 'docx', 'pptx', 'xlsx'])

function keywords(text: string): string[] {
  return [...new Set((text.match(/[\p{Script=Han}]{2,8}|[A-Za-z][A-Za-z0-9_-]{2,24}/gu) ?? [])
    .map(value => value.toLowerCase()).filter(value => !['this', 'that', 'with', 'from', 'return', 'const', 'function'].includes(value)))].slice(0, 10)
}

function safeTopic(value: string): string | null {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 48)
  return cleaned.length >= 2 && !cleaned.includes('..') ? cleaned : null
}

/**
 * A narrow Organizer-facing view over the existing read-only document adapter.
 * It deliberately does not write a LearningDocument or invoke a model: the
 * profile is only enough to improve a proposed destination before confirmation.
 */
export class OrganizerContentResolver {
  private readonly documents = new DocumentSourceAdapter()

  async resolveDocument(input: { absolutePath: string; relativePath: string; extension: string; contentHash: string; inputAssetId: string; taskId: string; projectId: string }): Promise<OrganizerDocumentProfile | null> {
    if (!DOCUMENT_TYPES.has(input.extension)) return null
    const source: DetectedKnowledgeSource = {
      source_type: 'local_file', source_reference: input.absolutePath,
      display_name: path.basename(input.relativePath),
      metadata: { input_asset_id: input.inputAssetId, source_mode: 'native_picker', organizer_profile_only: true },
    }
    try {
      const document = await this.documents.acquire(source, {
        taskId: input.taskId, projectId: input.projectId,
        report: () => { /* organizer emits its own bounded progress events */ },
      })
      const text = document.content.replace(/\s+/gu, ' ').trim()
      const terms = keywords(text)
      const nameTopic = safeTopic(path.basename(input.relativePath, path.extname(input.relativePath)).replace(/[_-]+/gu, ' '))
      const anchors = document.sections.slice(0, 12).map(section => section.source_anchor)
      const category = input.extension === 'xlsx' ? '数据' : '学习资料'
      return {
        source_file: input.relativePath, document_type: input.extension as OrganizerDocumentProfile['document_type'], title: document.title,
        summary: text.slice(0, 420), keywords: terms, topic: nameTopic ?? terms[0] ?? null,
        source_anchors: anchors, content_hash: input.contentHash, category,
        reason: `已通过本机只读${input.extension.toUpperCase()}解析器提取标题、章节和关键词。`,
      }
    } catch {
      // A damaged or protected document must remain available for deterministic
      // handling; the organizer never treats parsing failure as permission to move it.
      return null
    }
  }

  /** OCR is deliberately opt-in by candidate: a screenshot-like name or a
   * small image under a documents-oriented parent. Ordinary photos are never
   * queued here. Files are copied into Workbench runtime storage first, so no
   * manifest or OCR output is written into the user-selected folder. */
  async resolveCandidateImageText(input: { absolutePath: string; relativePath: string; taskId: string; index: number }): Promise<string | null> {
    if (PATHS.asrPython === null || input.index >= 8) return null
    const extension = path.extname(input.absolutePath).toLowerCase()
    if (!['.png', '.jpg', '.jpeg'].includes(extension) || !/(截图|screenshot|screen|作业|笔记|code|error|traceback)/iu.test(input.relativePath)) return null
    const info = await stat(input.absolutePath).catch(() => null)
    if (info === null || info.size > 12 * 1024 * 1024) return null
    const taskRoot = path.join(PATHS.dataRoot, 'runtime', 'organizer', input.taskId)
    const root = path.join(taskRoot, 'image-ocr')
    const file = `candidate-${input.index}${extension}`; const image = path.join(root, file)
    const manifest = path.join(taskRoot, 'image-ocr-manifest.json'); const output = path.join(taskRoot, 'image-ocr-result.json')
    try {
      await mkdir(root, { recursive: true }); await copyFile(input.absolutePath, image)
      await writeFile(manifest, `${JSON.stringify({ frames: [{ index: 0, file, timestamp_ms: 0 }] })}\n`, 'utf8')
      const worker = path.join(PATHS.appRoot, 'server', 'workers', 'ocr.py')
      const result = await runProcess(PATHS.asrPython, [worker, '--input-dir', root, '--manifest', manifest, '--output', output], { cwd: root, timeoutMs: 120_000 })
      if (result.exitCode !== 0 || result.timedOut) return null
      const body = JSON.parse(await readFile(output, 'utf8')) as { frames?: Array<{ text?: string }> }
      const text = body.frames?.[0]?.text?.replace(/\s+/gu, ' ').trim() ?? ''
      return text.length === 0 ? null : text.slice(0, 800)
    } catch { return null }
  }
}
