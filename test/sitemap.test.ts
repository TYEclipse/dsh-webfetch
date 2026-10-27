/**
 * Unit and end-to-end tests for the sitemap/robots reader: robots.txt
 * `Sitemap:` discovery, sitemap index following, per-URL metadata, output
 * caps, failure reporting (broken / gzip documents) and the text renderer —
 * all offline fixtures on a local server.
 *
 * ORACLE: test/oracle/anchors.py
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resolveConfig } from '../src/index.ts'
import { buildWebfetchTools, type SitemapReport, type SitemapUrlItem } from '../src/tools.ts'
import { isSitemapLike, parseRobots, parseSitemap, roundPriority, type SitemapUrl } from '../src/sitemap.ts'
import { assertLossless } from './helpers/lossless-json.ts'

const ROBOTS_FIXTURE = `# fixture robots
User-agent: *
Disallow: /admin  # keep crawlers out
Crawl-delay: 5

Sitemap: /sitemap-index.xml
Sitemap: /sitemap-a.xml
Sitemap: /sitemap-index.xml
`

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>/sitemap-a.xml</loc><lastmod>2026-10-20</lastmod></sitemap>
  <sitemap><loc>/sitemap-c.xml</loc></sitemap>
  <sitemap><loc>/sitemap-c.xml</loc></sitemap>
</sitemapindex>`

const SITEMAP_A = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>/docs/getting-started</loc><lastmod>2026-10-01</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://example.test/pricing?plan=a&amp;b=1</loc><lastmod>2026-09-20</lastmod><priority>0.8</priority></url>
  <url><loc>/blog/</loc></url>
</urlset>`

const SITEMAP_C = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>/about</loc><changefreq>monthly</changefreq><priority>0</priority></url>
  <url><loc>/contact</loc><lastmod>2026-08-15</lastmod></url>
</urlset>`

const SITEMAP_SINGLE = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>/only-page</loc></url>
</urlset>`

interface SitemapResult {
  url: string
  robotsUrl: string
  robotsStatus: number
  sitemapCount: number
  discovered: number
  urlCount: number
  truncated: boolean
  sitemaps: SitemapReport[]
  urls: SitemapUrlItem[]
}

type SitemapArgs = { url: string; maxUrls?: number; maxSitemaps?: number }

describe('parseRobots', () => {
  it('collects Sitemap directives in order, deduplicated, and the crawl delay', () => {
    const parsed = parseRobots(ROBOTS_FIXTURE)
    expect(parsed.sitemaps).toEqual(['/sitemap-index.xml', '/sitemap-a.xml'])
    expect(parsed.crawlDelay).toBe('5')
  })

  it('returns empty results for a robots.txt without sitemaps', () => {
    const parsed = parseRobots('User-agent: *\nDisallow: /\n')
    expect(parsed).toEqual({ sitemaps: [], crawlDelay: '' })
  })

  it('ignores blank lines, comments and malformed lines', () => {
    const parsed = parseRobots('\n# only a comment\nnot a directive\nSitemap:\n  SITEMAP : /upper.xml  \n')
    expect(parsed.sitemaps).toEqual(['/upper.xml'])
    expect(parsed.crawlDelay).toBe('')
  })
})

describe('parseSitemap', () => {
  it('extracts every <url> with its optional metadata', () => {
    const parsed = parseSitemap(SITEMAP_A)
    expect(parsed.kind).toBe('urlset')
    expect(parsed.sitemaps).toEqual([])
    expect(parsed.urls).toEqual([
      { loc: '/docs/getting-started', lastmod: '2026-10-01', changefreq: 'weekly', priority: 1 },
      { loc: 'https://example.test/pricing?plan=a&b=1', lastmod: '2026-09-20', changefreq: '', priority: 0.8 },
      { loc: '/blog/', lastmod: '', changefreq: '', priority: null },
    ])
  })

  it('reads a sitemap index as child sitemap locations, deduplicated', () => {
    const parsed = parseSitemap(SITEMAP_INDEX)
    expect(parsed.kind).toBe('sitemapindex')
    expect(parsed.sitemaps).toEqual(['/sitemap-a.xml', '/sitemap-c.xml'])
    expect(parsed.urls).toEqual([])
  })

  it('rejects a document that is neither a urlset nor an index', () => {
    expect(() => parseSitemap('<html><body><p>not a sitemap</p></body></html>'))
      .toThrow(/not a recognized sitemap document/)
  })
})

describe('sitemap helpers', () => {
  it('recognises sitemap-shaped URLs and rejects everything else', () => {
    expect(isSitemapLike('https://example.test/sitemap.xml')).toBe(true)
    expect(isSitemapLike('https://example.test/sitemaps/news.xml')).toBe(true)
    expect(isSitemapLike('https://example.test/archive/sitemap.xml.gz')).toBe(true)
    expect(isSitemapLike('https://example.test/blog/post-1')).toBe(false)
    expect(isSitemapLike('not a url')).toBe(false)
  })

  it('folds -0 into 0 and keeps two decimals', () => {
    const zero = roundPriority(-0)
    expect(Object.is(zero, -0)).toBe(false)
    expect(zero).toBe(0)
    expect(roundPriority(0)).toBe(0)
    expect(roundPriority(0.804)).toBe(0.8)
    expect(roundPriority(1)).toBe(1)
  })
})

describe('web_sitemap end-to-end (fixture server)', () => {
  let server: Server
  let bare: Server
  let base: string
  let bareBase: string

  const sitemapRun = (url: string, args: Partial<SitemapArgs> = {}): Promise<SitemapResult> => {
    const tools = buildWebfetchTools(resolveConfig({}, {}))
    const run = tools.web_sitemap.execute as (input: SitemapArgs) => Promise<SitemapResult>
    return run({ url, ...args })
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const xml = (body: string): void => {
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
        res.end(body)
      }
      if (url.pathname === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(ROBOTS_FIXTURE)
        return
      }
      if (url.pathname === '/sitemap-index.xml') {
        xml(SITEMAP_INDEX)
        return
      }
      if (url.pathname === '/sitemap-a.xml') {
        xml(SITEMAP_A)
        return
      }
      if (url.pathname === '/sitemap-c.xml') {
        xml(SITEMAP_C)
        return
      }
      if (url.pathname === '/sitemap.xml') {
        xml(SITEMAP_SINGLE)
        return
      }
      if (url.pathname === '/broken-sitemap.xml') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body><p>not a sitemap at all</p></body></html>')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('failed to bind fixture server')
    base = `http://127.0.0.1:${address.port}`

    // Second origin: publishes /sitemap.xml but no robots.txt at all.
    bare = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
        res.end(SITEMAP_SINGLE)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve))
    const bareAddress = bare.address()
    if (bareAddress === null || typeof bareAddress === 'string') throw new Error('failed to bind bare fixture server')
    bareBase = `http://127.0.0.1:${bareAddress.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => bare.close(() => resolve()))
  })

  it('discovers sitemaps through robots.txt and follows the index', async () => {
    const result = await sitemapRun(`${base}/blog/post-1`)
    expect(result.robotsUrl).toBe(`${base}/robots.txt`)
    expect(result.robotsStatus).toBe(200)
    expect(result.sitemapCount).toBe(3)
    expect(result.discovered).toBe(5)
    expect(result.urlCount).toBe(5)
    expect(result.truncated).toBe(false)
    expect(result.sitemaps).toEqual([
      { url: `${base}/sitemap-index.xml`, kind: 'index', status: 200, entryCount: 2, error: '' },
      { url: `${base}/sitemap-a.xml`, kind: 'urlset', status: 200, entryCount: 3, error: '' },
      { url: `${base}/sitemap-c.xml`, kind: 'urlset', status: 200, entryCount: 2, error: '' },
    ])
    expect(result.urls).toEqual([
      { loc: `${base}/docs/getting-started`, lastmod: '2026-10-01', changefreq: 'weekly', priority: 1 },
      { loc: 'https://example.test/pricing?plan=a&b=1', lastmod: '2026-09-20', priority: 0.8 },
      { loc: `${base}/blog/` },
      { loc: `${base}/about`, changefreq: 'monthly', priority: 0 },
      { loc: `${base}/contact`, lastmod: '2026-08-15' },
    ])
    assertLossless(result)
  })

  it('caps the returned URLs but still reports how many were discovered', async () => {
    const result = await sitemapRun(`${base}/blog/post-1`, { maxUrls: 2 })
    expect(result.urlCount).toBe(2)
    expect(result.discovered).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.urls.map((entry) => entry.loc)).toEqual([
      `${base}/docs/getting-started`,
      'https://example.test/pricing?plan=a&b=1',
    ])
  })

  it('caps the number of sitemap documents fetched', async () => {
    const result = await sitemapRun(`${base}/blog/post-1`, { maxSitemaps: 1 })
    expect(result.sitemapCount).toBe(1)
    expect(result.sitemaps[0]?.kind).toBe('index')
    expect(result.urlCount).toBe(0)
    expect(result.truncated).toBe(true)
  })

  it('reads a sitemap URL directly without touching robots.txt', async () => {
    const result = await sitemapRun(`${base}/sitemap-a.xml`)
    expect(result.robotsUrl).toBe('')
    expect(result.robotsStatus).toBe(0)
    expect(result.sitemapCount).toBe(1)
    expect(result.urlCount).toBe(3)
    expect(result.truncated).toBe(false)
  })

  it('falls back to /sitemap.xml when robots.txt is missing', async () => {
    const result = await sitemapRun(`${bareBase}/no-robots/page`)
    expect(result.robotsStatus).toBe(0)
    expect(result.sitemaps[0]?.url).toBe(`${bareBase}/sitemap.xml`)
    expect(result.urlCount).toBe(1)
    expect(result.urls[0]?.loc).toBe(`${bareBase}/only-page`)
  })

  it('reports a non-sitemap document instead of aborting', async () => {
    const result = await sitemapRun(`${base}/broken-sitemap.xml`)
    expect(result.sitemapCount).toBe(1)
    expect(result.sitemaps[0]?.kind).toBe('error')
    expect(result.sitemaps[0]?.error).toMatch(/not a recognized sitemap document/)
    expect(result.urlCount).toBe(0)
    expect(result.truncated).toBe(false)
    assertLossless(result)
  })

  it('skips gzip-compressed sitemaps with an explicit reason', async () => {
    const result = await sitemapRun(`${base}/archive/sitemap.xml.gz`)
    expect(result.sitemaps[0]?.kind).toBe('gzip')
    expect(result.sitemaps[0]?.error).toMatch(/gzip-compressed/)
    expect(result.urlCount).toBe(0)
  })

  it('rejects an unsupported protocol before any fetch', async () => {
    await expect(sitemapRun('file:///etc/hosts')).rejects.toThrow(/only http and https/)
  })

  it('renders the inventory as a readable listing', () => {
    const tools = buildWebfetchTools(resolveConfig({}, {}))
    const value = {
      url: 'https://example.test/blog',
      robotsUrl: 'https://example.test/robots.txt',
      robotsStatus: 200,
      sitemapCount: 1,
      discovered: 2,
      urlCount: 2,
      truncated: false,
      sitemaps: [{ url: 'https://example.test/sitemap.xml', kind: 'urlset', status: 200, entryCount: 2, error: '' }],
      urls: [
        { loc: 'https://example.test/docs', lastmod: '2026-10-01', changefreq: 'weekly', priority: 1 },
        { loc: 'https://example.test/about' },
      ],
    }
    const block = tools.web_sitemap.output.render({ url: value.url }, value)
    const text = (block[0] as { text: string }).text
    expect(text).toContain('sitemap inventory of https://example.test/blog — robots HTTP 200 (https://example.test/robots.txt)')
    expect(text).toContain('sitemap https://example.test/sitemap.xml — urlset HTTP 200, 2 entries')
    expect(text).toContain('2 of 2 discovered URL(s):')
    expect(text).toContain('1. https://example.test/docs — lastmod 2026-10-01, weekly, priority 1')
    expect(text).toContain('2. https://example.test/about')
  })

  it('renders an empty inventory and a direct-input header', () => {
    const tools = buildWebfetchTools(resolveConfig({}, {}))
    const block = tools.web_sitemap.output.render(
      { url: 'https://example.test/sitemap.xml' },
      {
        url: 'https://example.test/sitemap.xml',
        robotsUrl: '',
        robotsStatus: 0,
        sitemapCount: 1,
        discovered: 0,
        urlCount: 0,
        truncated: true,
        sitemaps: [{ url: 'https://example.test/sitemap.xml', kind: 'error', status: 0, entryCount: 0, error: 'HTTP 404 Not Found' }],
        urls: [],
      },
    )
    const text = (block[0] as { text: string }).text
    expect(text).toContain('(direct sitemap input)')
    expect(text).toContain('— error, 0 entries (HTTP 404 Not Found)')
    expect(text).toContain('no URLs found')
    expect(text).toContain('[output capped')
  })
})
