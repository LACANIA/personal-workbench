import { describe, expect, it } from 'vitest'
import { fetchPublicHttp, isDeniedAddress, validatePublicHttpUrl } from '../src/sources/safe-http.ts'
import { WebSourceAdapter, normalizeHtmlToUnifiedDocument } from '../src/sources/web-source-adapter.ts'

describe('STEP-34 WebSourceAdapter', () => {
  it('rejects local, private, credentialed and non-http URLs before a request', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.5', 'file:///C:/secret.txt', 'ftp://example.com', 'https://user:pass@example.com']) {
      expect(() => validatePublicHttpUrl(url)).toThrow()
    }
    expect(isDeniedAddress('169.254.1.1')).toBe(true)
    expect(isDeniedAddress('8.8.8.8')).toBe(false)
  })

  it('rejects an explicit private target during adapter inspection', async () => {
    await expect(new WebSourceAdapter().inspect({
      source_type: 'web_url', source_reference: 'http://127.0.0.1:11434/api/tags', display_name: 'private', metadata: {},
    })).rejects.toThrow('SOURCE_URL_PRIVATE_NETWORK_DENIED')
  })

  it('checks redirects again and reads only bounded public content', async () => {
    const requests: string[] = []
    const response = await fetchPublicHttp('https://public.example/start', {
      lookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as never,
      fetcher: (async (input: URL | RequestInfo) => {
        requests.push(String(input))
        if (requests.length === 1) return new Response(null, { status: 302, headers: { location: 'https://public.example/article' } })
        return new Response('<html><body><article><p>公开正文</p></article></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      }) as typeof fetch,
    })
    expect(response.url.toString()).toBe('https://public.example/article')
    expect(response.redirect_count).toBe(1)
    expect(requests).toHaveLength(2)
  })

  it('cleans HTML into headings, text, links and code without scripts or navigation', () => {
    const document = normalizeHtmlToUnifiedDocument({
      sourceType: 'web_url', sourceUrl: 'https://example.com/article', canonicalUrl: 'https://example.com/article', contentType: 'text/html',
      html: `<!doctype html><html lang="zh-CN"><head><title>示例文章</title><meta name="description" content="公开技术页面"></head><body><nav>导航内容</nav><article><h1 id="main">函数映射</h1><p>map 会把数组中的每一个元素转换为新的值，适合在不改变原数组的场景中使用。它不会直接改写原数组，因此在界面状态处理和数据整理时经常与过滤、归约等操作组合使用。</p><p>当转换过程依赖外部配置时，应当把配置作为明确参数传入回调函数。这样同一个数据集可以得到不同的展示结果，同时仍然能够追溯每一步转换的来源与目的。</p><h2>代码</h2><pre><code class="language-js">const doubled = values.map(value => value * 2)</code></pre><p>更多资料请阅读 <a href="/docs">相关文档</a>，并注意回调函数应保持可读性。实际编写时可以先为转换逻辑命名，再把输入数据和输出数据分别检查一遍，这样更容易定位边界条件和空数组的处理方式。</p><p>对于学习资料，代码示例只说明已经出现的转换关系。文章没有给出性能数据时，整理结果也不应自行推测算法速度或内存占用。</p></article><footer>页脚</footer><script>window.secret = true</script></body></html>`,
    })
    expect(document.title).toBe('示例文章')
    expect(document.content).toContain('函数映射')
    expect(document.content).toContain('const doubled')
    expect(document.content).not.toContain('导航内容')
    expect(document.content).not.toContain('window.secret')
    expect(document.sections.some(section => section.heading === '函数映射')).toBe(true)
    expect(document.code_blocks).toMatchObject([{ language: 'js' }])
    expect(document.links).toContain('https://example.com/docs')
  })

  it('reports a script-rendered page separately from a genuinely short article', () => {
    expect(() => normalizeHtmlToUnifiedDocument({
      sourceType: 'web_url', sourceUrl: 'https://example.com/app', canonicalUrl: 'https://example.com/app', contentType: 'text/html',
      html: '<html><head><script src="/bundle.js"></script></head><body><div id="root"></div></body></html>',
    })).toThrow('DYNAMIC_PAGE_UNSUPPORTED')
    expect(() => normalizeHtmlToUnifiedDocument({
      sourceType: 'web_url', sourceUrl: 'https://example.com/short', canonicalUrl: 'https://example.com/short', contentType: 'text/html',
      html: '<html><body><article><p>很短的页面。</p></article></body></html>',
    })).toThrow('CONTENT_TOO_SHORT')
  })

  it('keeps a long prose preformatted page as article text rather than source code', () => {
    const prose = 'The JSON format describes structured data for interoperable exchange. '.repeat(22)
    const document = normalizeHtmlToUnifiedDocument({
      sourceType: 'web_url', sourceUrl: 'https://example.com/rfc', canonicalUrl: 'https://example.com/rfc', contentType: 'text/html',
      html: `<html><body><pre>${prose}</pre></body></html>`,
    })
    expect(document.content).toContain('JSON format')
    expect(document.code_blocks).toEqual([])
    expect(document.sections).toMatchObject([{ heading: '正文' }])
  })
})
