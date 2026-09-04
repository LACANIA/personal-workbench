import type { TaskTemplate, TemplateId } from '../../../shared/contracts/index.ts'

export function recognizeInput(input: string): { type: string; recommended: TemplateId[]; label: string } {
  const value = input.trim()
  // A pasted link often carries a human title or instruction before it.  Keep
  // the text intact for the ingestion service, while treating it as a URL
  // source here so the universal ingress can choose the correct adapter.
  if (/https?:\/\/[^\s<>\]\["']+/iu.test(value)) return { type: 'url', recommended: ['video-to-knowledge'], label: '网址' }
  if (/^[A-Za-z]:[\\/]/u.test(value)) {
    if (/\.(?:mp4|mkv|mov|webm|wav|mp3|m4a|flac|srt|vtt)$/iu.test(value)) return { type: 'file', recommended: ['video-to-knowledge'], label: '本机媒体文件' }
    if (/\.[^\\/.]{1,12}$/u.test(value)) return { type: 'file', recommended: ['file-analysis', 'document-chunk-search'], label: '本机文件' }
    return { type: 'directory', recommended: ['asset-inventory', 'file-analysis'], label: '本机文件夹' }
  }
  return { type: 'natural_language', recommended: ['memory-query', 'project-summary'], label: '自然语言问题' }
}

export function orderedTemplates(input: string, templates: TaskTemplate[]): TaskTemplate[] {
  const preferred = recognizeInput(input).recommended
  return [...templates].sort((a, b) => {
    const ai = preferred.indexOf(a.id)
    const bi = preferred.indexOf(b.id)
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })
}
