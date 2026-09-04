import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/database.ts'
import { HierarchicalDocumentProcessor } from '../src/documents/hierarchical-document.ts'

const paths: string[] = []

describe('STEP-36 HierarchicalDocumentProcessor', () => {
  afterEach(async () => { await Promise.all(paths.splice(0).map(file => rm(file, { force: true }))) })

  it('keeps source anchors and reuses summaries for an unchanged document', () => {
    const file = path.join(process.cwd(), 'data', `step36-hierarchy-${randomUUID()}.db`); paths.push(file)
    const database = new WorkbenchDatabase(file); database.db.exec('PRAGMA foreign_keys=OFF')
    const document = {
      id: randomUUID(), task_id: randomUUID(), project_id: randomUUID(), source_type: 'local_file' as const,
      source_url: 'local-document:test', canonical_url: 'local-document:test', title: '长资料', author: null, site_name: '本机文档', description: null, language: 'zh', content_type: 'text/markdown',
      content: '', sections: Array.from({ length: 10 }, (_, index) => ({ heading: `第${index + 1}章`, level: 1, text: `第${index + 1}章的学习内容。`.repeat(800), source_anchor: `page:${index + 1}` })),
      code_blocks: [], links: [], metadata: {}, acquired_at: new Date().toISOString(), content_sha256: 'a'.repeat(64),
    }
    document.content = document.sections.map(item => item.text).join('\n')
    database.createUnifiedDocument(document)
    const processor = new HierarchicalDocumentProcessor(database)
    const first = processor.process(document)
    const second = processor.process(document)
    expect(first.chunk_count).toBeGreaterThan(1)
    expect(first.section_summaries.some(item => item.source_range.includes('page:3'))).toBe(true)
    expect(second.reused_chunk_count).toBe(first.chunk_count)
    database.db.close()
  })
})
