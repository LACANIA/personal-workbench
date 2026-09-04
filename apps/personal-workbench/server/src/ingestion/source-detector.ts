import { createHash } from 'node:crypto'
import path from 'node:path'
import { KNOWLEDGE_SOURCE_TYPES, type DetectedKnowledgeSource, type KnowledgeIngestionInput, type VideoInputType } from '../../../shared/contracts/index.ts'
import { UniversalInputService } from '../input/service.ts'
import { normalizeGithubRepositoryUrl } from '../sources/github-source-adapter.ts'

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt'])
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.flac'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm'])
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx'])

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 24_000 || value.includes('\0')) throw new Error('KNOWLEDGE_SOURCE_INPUT_INVALID')
  return value.trim()
}

function extension(value: string): string { return path.extname(value).toLowerCase() }

function titleForUrl(url: URL, sourceType: DetectedKnowledgeSource['source_type']): string {
  if (sourceType === 'github_repo') {
    const parts = url.pathname.split('/').filter(Boolean)
    return parts.length >= 2 ? `${parts[0]}/${parts[1]!.replace(/\.git$/iu, '')}` : url.hostname
  }
  return url.hostname
}

function cleanUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('KNOWLEDGE_SOURCE_URL_INVALID') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username.length > 0 || url.password.length > 0) throw new Error('KNOWLEDGE_SOURCE_URL_DENIED')
  url.hash = ''
  return url
}

function localReference(value: string): string {
  return path.normalize(value).replace(/[\\/]+$/u, '')
}

function hostnameMatches(hostname: string, expected: string): boolean {
  return hostname === expected || hostname.endsWith(`.${expected}`)
}

function isGithubRepository(url: URL): boolean {
  const segments = url.pathname.split('/').filter(Boolean)
  return hostnameMatches(url.hostname.toLowerCase(), 'github.com') && segments.length >= 2
}

function isVideoUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase()
  const pathname = url.pathname.toLowerCase()
  if (hostnameMatches(hostname, 'b23.tv')) return true
  if (hostnameMatches(hostname, 'bilibili.com')) return pathname.startsWith('/video/')
  if (hostnameMatches(hostname, 'youtu.be')) return true
  if (hostnameMatches(hostname, 'youtube.com')) return pathname === '/watch' || pathname.startsWith('/watch/')
  if (hostnameMatches(hostname, 'douyin.com')) return pathname.startsWith('/video/')
  return hostnameMatches(hostname, 'vimeo.com')
}

function extractedTitle(value: string, urlStart: number): string | null {
  const prefix = value.slice(0, urlStart).trim()
  if (prefix.length === 0) return null
  const markdown = prefix.match(/\[([^\]\r\n]{1,160})\]\(\s*$/u)
  const candidate = (markdown?.[1] ?? prefix)
    .replace(/^[【\[\(（\s]+|[】\]\)）\s]+$/gu, '')
    .trim()
    .slice(0, 160)
  return candidate.length === 0 ? null : candidate
}

function userInstruction(value: string, urlStart: number): string | null {
  const prefix = value.slice(0, urlStart).trim()
  if (prefix.length === 0) return null
  const normalized = prefix
    .replace(/[【\[（(\s]+$/gu, '')
    .trim()
    .slice(0, 600)
  return normalized.length === 0 ? null : normalized
}

function extractUrl(value: string): { url: string; title: string | null } | null {
  const match = /https?:\/\/[^\s<>"'`]+/iu.exec(value)
  if (match === null || match.index === undefined) return null
  const trimmed = match[0].replace(/[),.，。】》]+$/u, '')
  if (trimmed.length === 0) return null
  return { url: trimmed, title: extractedTitle(value, match.index) }
}

export function mediaInputTypeForFile(value: string): VideoInputType | null {
  const suffix = extension(value)
  if (SUBTITLE_EXTENSIONS.has(suffix)) return 'subtitle'
  if (AUDIO_EXTENSIONS.has(suffix)) return 'audio'
  if (VIDEO_EXTENSIONS.has(suffix)) return 'local_video'
  return null
}

export function documentSubtypeForFile(value: string): 'pdf' | 'docx' | 'pptx' | 'xlsx' | null {
  const suffix = extension(value)
  return DOCUMENT_EXTENSIONS.has(suffix) ? suffix.slice(1) as 'pdf' | 'docx' | 'pptx' | 'xlsx' : null
}

export class SourceDetector {
  constructor(private readonly inputs: UniversalInputService) {}

  detect(input: KnowledgeIngestionInput): DetectedKnowledgeSource {
    if (input.input_asset_id !== undefined) return this.detectInputAsset(input.input_asset_id)
    const value = requiredText(input.input_value)
    const url = extractUrl(value)
    if (url !== null) {
      const detected = this.detectUrl(url.url, url.title, userInstruction(value, value.indexOf(url.url)))
      if (input.source_type_override === undefined) return detected
      if (!KNOWLEDGE_SOURCE_TYPES.includes(input.source_type_override) || !['video_url', 'web_url', 'github_repo'].includes(input.source_type_override)) throw new Error('KNOWLEDGE_SOURCE_OVERRIDE_DENIED')
      return { ...detected, source_type: input.source_type_override, metadata: { ...detected.metadata, source_type_override: input.source_type_override } }
    }
    if (/^[A-Za-z]:[\\/]/u.test(value) || path.isAbsolute(value)) {
      const reference = localReference(value)
      const suffix = extension(reference)
      return suffix.length > 0
        ? { source_type: 'local_file', source_reference: reference, display_name: path.basename(reference), metadata: { source_mode: 'manual_path', extension: suffix, authorization_required: true, media_input_type: mediaInputTypeForFile(reference) } }
        : { source_type: 'local_folder', source_reference: reference, display_name: path.basename(reference) || reference, metadata: { source_mode: 'manual_path', authorization_required: true } }
    }
    const textHash = createHash('sha256').update(value, 'utf8').digest('hex')
    return {
      source_type: 'text_input', source_reference: `text:${textHash}`, display_name: '文本输入',
      metadata: { text_length: value.length, text_sha256: textHash, line_count: value.split(/\r?\n/gu).length },
    }
  }

  private detectInputAsset(id: string): DetectedKnowledgeSource {
    const view = this.inputs.get(id)
    const effectivePath = view.effective_path
    if (effectivePath === null) throw new Error('KNOWLEDGE_SOURCE_PATH_UNAVAILABLE')
    if (view.asset.input_type === 'directory') {
      return {
        source_type: 'local_folder', source_reference: effectivePath, display_name: view.asset.display_name,
        metadata: { input_asset_id: view.asset.id, source_mode: view.asset.source_mode, access_mode: view.asset.access_mode, mime_type: view.asset.mime_type },
      }
    }
    if (view.asset.input_type !== 'file') throw new Error('KNOWLEDGE_SOURCE_INPUT_TYPE_UNSUPPORTED')
    return {
      source_type: 'local_file', source_reference: effectivePath, display_name: view.asset.display_name,
      metadata: {
        input_asset_id: view.asset.id, source_mode: view.asset.source_mode, access_mode: view.asset.access_mode,
        mime_type: view.asset.mime_type, size_bytes: view.asset.size_bytes, sha256: view.asset.sha256,
        extension: extension(effectivePath), capability: view.capability, media_input_type: mediaInputTypeForFile(effectivePath), document_subtype: documentSubtypeForFile(effectivePath),
      },
    }
  }

  private detectUrl(value: string, inputTitle: string | null, instruction: string | null): DetectedKnowledgeSource {
    const url = cleanUrl(value)
    const hostname = url.hostname.toLowerCase()
    let github: ReturnType<typeof normalizeGithubRepositoryUrl> | null = null
    if (isGithubRepository(url)) github = normalizeGithubRepositoryUrl(url.toString())
    const sourceType: DetectedKnowledgeSource['source_type'] = github !== null ? 'github_repo' : isVideoUrl(url) ? 'video_url' : 'web_url'
    // Repository imports are pinned to their repository root. Issue, pull request
    // and file links retain their own URL so the Web adapter never silently reads
    // a repository homepage in place of the user-selected page.
    const canonical = github?.kind === 'repository' ? github.canonical : url.toString()
    return {
      source_type: sourceType,
      source_reference: canonical,
      display_name: inputTitle ?? titleForUrl(url, sourceType),
      metadata: {
        hostname, pathname: url.pathname, protocol: url.protocol, query_present: url.search.length > 0,
        ...(inputTitle === null ? {} : { input_title: inputTitle }), ...(instruction === null ? {} : { user_instruction: instruction }),
        ...(github === null ? {} : { github_kind: github.kind, github_owner: github.owner, github_repo: github.repo }),
      },
    }
  }
}
