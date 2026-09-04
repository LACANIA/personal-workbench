import dns from 'node:dns/promises'
import net from 'node:net'
import { SourceAdapterError } from './types.ts'

export const MAX_WEB_RESPONSE_BYTES = 3 * 1024 * 1024
export const MAX_WEB_REDIRECTS = 4
export const WEB_FETCH_TIMEOUT_MS = 15_000

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.').map(value => Number(value))
  return parts.length === 4 && parts.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ? parts : null
}

export function isDeniedAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) {
    const parts = ipv4Parts(address)
    if (parts === null) return true
    const first = parts[0]!
    const second = parts[1]!
    return first === 0 || first === 10 || first === 127 || first === 169 && second === 254
      || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168
      || first === 100 && second >= 64 && second <= 127 || first === 198 && (second === 18 || second === 19)
  }
  if (family === 6) {
    const value = address.toLowerCase()
    return value === '::1' || value === '::' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')
      || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.')
  }
  return true
}

export function validatePublicHttpUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new SourceAdapterError('SOURCE_URL_INVALID', '链接格式无效，请粘贴完整的公开网页或 GitHub 地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username.length > 0 || url.password.length > 0) {
    throw new SourceAdapterError('SOURCE_URL_DENIED', '当前只读取公开 HTTP(S) 链接，不能使用本机路径、账号信息或其他协议。')
  }
  const host = url.hostname.toLowerCase().replace(/[\[\]]/gu, '')
  if (host === 'localhost' || host.endsWith('.localhost') || net.isIP(host) !== 0 && isDeniedAddress(host)) {
    throw new SourceAdapterError('SOURCE_URL_PRIVATE_NETWORK_DENIED', '该链接指向本机或私有网络地址，工作台不会访问。')
  }
  url.hash = ''
  return url
}

export async function assertPublicDnsTarget(url: URL, lookup: typeof dns.lookup = dns.lookup): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new SourceAdapterError('SOURCE_URL_PRIVATE_NETWORK_DENIED', '该链接指向本机或私有网络地址，工作台不会访问。')
  }
  if (net.isIP(hostname) !== 0) {
    if (isDeniedAddress(hostname)) throw new SourceAdapterError('SOURCE_URL_PRIVATE_NETWORK_DENIED', '该链接指向本机或私有网络地址，工作台不会访问。')
    return
  }
  let records: Array<{ address: string }>
  try { records = await lookup(hostname, { all: true, verbatim: true }) as Array<{ address: string }> } catch {
    throw new SourceAdapterError('SOURCE_DNS_LOOKUP_FAILED', '无法确认该公开网站的网络地址，请检查链接后重试。', 502)
  }
  if (records.length === 0 || records.some(record => isDeniedAddress(record.address))) {
    throw new SourceAdapterError('SOURCE_URL_PRIVATE_NETWORK_DENIED', '该链接的目标地址不在公开网络范围，工作台不会访问。')
  }
}

async function boundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maximumBytes) throw new SourceAdapterError('SOURCE_RESPONSE_TOO_LARGE', '网页内容过大，已经停止读取。')
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const pieces: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maximumBytes) {
      await reader.cancel()
      throw new SourceAdapterError('SOURCE_RESPONSE_TOO_LARGE', '网页内容过大，已经停止读取。')
    }
    pieces.push(next.value)
  }
  return Buffer.concat(pieces.map(piece => Buffer.from(piece)))
}

export interface SafeHttpResponse {
  url: URL
  status: number
  headers: Headers
  body: Buffer
  redirect_count: number
}

/** Fetch with manual redirect handling so every network target gets the same SSRF checks. */
export async function fetchPublicHttp(
  initial: string | URL,
  options: { maximumBytes?: number; timeoutMs?: number; fetcher?: typeof fetch; lookup?: typeof dns.lookup } = {},
): Promise<SafeHttpResponse> {
  const fetcher = options.fetcher ?? fetch
  const maximumBytes = options.maximumBytes ?? MAX_WEB_RESPONSE_BYTES
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS
  const lookup = options.lookup ?? dns.lookup
  let url = validatePublicHttpUrl(String(initial))
  for (let redirectCount = 0; redirectCount <= MAX_WEB_REDIRECTS; redirectCount += 1) {
    await assertPublicDnsTarget(url, lookup)
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.8,*/*;q=0.2',
          'User-Agent': 'PersonalWorkbench/1.0 PublicSourceReader',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        },
      })
    } catch (error) {
      if (error instanceof SourceAdapterError) throw error
      throw new SourceAdapterError('SOURCE_FETCH_FAILED', '无法连接该公开页面，请检查网络或稍后重试。', 502)
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (location === null || location.length === 0) throw new SourceAdapterError('SOURCE_REDIRECT_INVALID', '网页重定向地址无效。', 502)
      if (redirectCount === MAX_WEB_REDIRECTS) throw new SourceAdapterError('SOURCE_REDIRECT_LIMIT', '网页重定向次数过多，已经停止读取。')
      url = validatePublicHttpUrl(new URL(location, url).toString())
      continue
    }
    if (!response.ok) throw new SourceAdapterError(`SOURCE_HTTP_${response.status}`, `网页返回了 ${response.status}，当前无法读取公开正文。`, 502)
    return { url, status: response.status, headers: response.headers, body: await boundedBody(response, maximumBytes), redirect_count: redirectCount }
  }
  throw new SourceAdapterError('SOURCE_REDIRECT_LIMIT', '网页重定向次数过多，已经停止读取。')
}
