/**
 * Tests for src/meta.ts — document metadata extraction (web_meta).
 *
 * ORACLE: test/oracle/anchors.py
 *
 * Every expectation below is printed by the oracle (section [6] of
 * `python3 test/oracle/anchors.py`); the oracle implements the same documented
 * semantics twice — once on top of Python's `html.parser` and once with plain
 * regex derivations over the fixture source — and cross-checks both in
 * `--check`. Do not hand-edit an expectation without re-running the oracle.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resolveConfig } from '../src/index.ts'
import { buildWebfetchTools } from '../src/tools.ts'
import { extractMeta, MAX_HEAD_SCAN, MAX_JSON_LD_BLOCKS, MAX_META_REFS, MAX_META_TEXT } from '../src/meta.ts'

/** The shared fixture, byte-identical to META_FIXTURE in test/oracle/anchors.py. */
const META_FIXTURE = '<!doctype html>'
  + '<html lang="en-GB">'
  + '<head>'
  + '<meta charset="utf-8">'
  + '<title>Widget &amp; Co \u2014 Home</title>'
  + '<meta name="description" content="  Widgets for   everyone ">'
  + '<meta name="robots" content="index,follow">'
  + '<meta name="author" content="A. Author">'
  + '<meta property="og:title" content="Widget &amp; Co">'
  + '<meta property="og:image" content="/img/hero.png">'
  + '<meta property="og:image" content="/img/hero.png">'
  + '<meta property="og:image" content="/img/second.png">'
  + '<meta property="article:published_time" content="2026-01-02T03:04:05Z">'
  + '<meta name="twitter:card" content="summary_large_image">'
  + '<meta property="twitter:site" content="@widget">'
  + '<link rel="canonical" href="/products/widget">'
  + '<link rel="alternate" hreflang="en" href="/en/widget">'
  + '<link rel="alternate" hreflang="zh-Hans" href="/zh/widget">'
  + '<link rel="alternate" type="application/rss+xml" title="Blog feed" href="/feed.xml">'
  + '<link rel="alternate" type="application/atom+xml" href="/atom.xml">'
  + '<link rel="icon" href="/favicon.ico">'
  + '<link rel="apple-touch-icon" href="/apple-touch-icon.png">'
  + '<link rel="icon" href="/favicon.ico">'
  + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>'
  + '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Organization","Brand"]}]}</script>'
  + '<script type="application/ld+json">{ this is not json }</script>'
  + '<script type="application/ld+json">   </script>'
  + '<script>var ignored = 1;</script>'
  + '</head>'
  + '<body><meta name="description" content="body copy must be ignored">'
  + '<link rel="canonical" href="/wrong"></body></html>'

const extract = (html: string, maxJsonLd = MAX_JSON_LD_BLOCKS) => extractMeta(html, { maxJsonLd })

describe('extractMeta (oracle-anchored fixture)', () => {
  const meta = extract(META_FIXTURE)

  it('M1 reads the head-level single-value fields', () => {
    expect(meta.title).toBe('Widget & Co \u2014 Home')
    expect(meta.description).toBe('Widgets for everyone')
    expect(meta.canonical).toBe('/products/widget')
    expect(meta.lang).toBe('en-GB')
    expect(meta.charset).toBe('utf-8')
    expect(meta.robots).toBe('index,follow')
    expect(meta.author).toBe('A. Author')
  })

  it('M2 keeps ordered Open Graph/article properties and drops exact duplicates', () => {
    expect(meta.openGraph.map((entry) => entry.name))
      .toEqual(['og:title', 'og:image', 'og:image', 'article:published_time'])
    expect(meta.openGraph.map((entry) => entry.content))
      .toEqual(['Widget & Co', '/img/hero.png', '/img/second.png', '2026-01-02T03:04:05Z'])
    expect(meta.twitter.map((entry) => entry.name)).toEqual(['twitter:card', 'twitter:site'])
    expect(meta.twitter[0]?.content).toBe('summary_large_image')
  })

  it('M3 collects hreflang alternates, feed autodiscovery links and deduplicated icons', () => {
    expect(meta.alternates).toEqual([
      { hreflang: 'en', href: '/en/widget' },
      { hreflang: 'zh-Hans', href: '/zh/widget' },
    ])
    expect(meta.feeds).toEqual([
      { type: 'application/rss+xml', title: 'Blog feed', href: '/feed.xml' },
      { type: 'application/atom+xml', title: '', href: '/atom.xml' },
    ])
    expect(meta.icons).toEqual(['/favicon.ico', '/apple-touch-icon.png'])
  })

  it('M4 summarises JSON-LD blocks and reports the invalid one instead of dropping it', () => {
    expect(meta.jsonLdCount).toBe(3)
    expect(meta.jsonLdInvalid).toBe(1)
    expect(meta.jsonLd[0]).toEqual({ index: 1, valid: true, types: ['Product'] })
    expect(meta.jsonLd[1]).toEqual({ index: 2, valid: true, types: ['WebPage', 'Organization', 'Brand'] })
    expect(meta.jsonLd[2]?.valid).toBe(false)
    expect(meta.jsonLd[2]?.types).toEqual([])
    expect((meta.jsonLd[2]?.error ?? '').length).toBeGreaterThan(0)
  })

  it('M5 ignores metadata outside the head and blank JSON-LD blocks', () => {
    expect(meta.description).toBe('Widgets for everyone')
    expect(meta.canonical).toBe('/products/widget')
    expect(meta.truncated).toBe(false)
    expect(meta.jsonLdCount).toBe(3)
  })
})

describe('extractMeta edge cases (oracle [6] legacy fixtures)', () => {
  it('E1 reads the legacy http-equiv charset declaration', () => {
    const meta = extract('<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>Legacy</title></head><body></body></html>')
    expect(meta.charset).toBe('iso-8859-1')
    expect(meta.title).toBe('Legacy')
  })

  it('E2 scans the whole document when the head is unclosed', () => {
    const meta = extract('<html><head><title>No closing head</title><meta name="robots" content="noindex">')
    expect(meta.title).toBe('No closing head')
    expect(meta.robots).toBe('noindex')
    expect(meta.truncated).toBe(false)
  })

  it('E3 truncates an oversized value to the cap plus an ellipsis', () => {
    const meta = extract(`<html><head><meta name="description" content="${'x'.repeat(MAX_META_TEXT + 50)}">`)
    expect(meta.description.length).toBe(MAX_META_TEXT + 1)
    expect(meta.description.endsWith('\u2026')).toBe(true)
  })

  it('E4 rejects an oversized JSON-LD block with a reason and no parse attempt', () => {
    const meta = extract(`<html><head><script type="application/ld+json">${'{'.repeat(100_001)}</script>`)
    expect(meta.jsonLdCount).toBe(1)
    expect(meta.jsonLdInvalid).toBe(1)
    expect(meta.jsonLd[0]?.valid).toBe(false)
    expect(meta.jsonLd[0]?.error).toContain('block too large')
    expect(meta.jsonLd[0]?.error).toContain('100000')
  })

  it('E5 honours the JSON-LD block cap while still counting every block', () => {
    const blocks = Array.from({ length: 12 }, (_, index) => `<script type="application/ld+json">{"@type":"T${index}"}</script>`).join('')
    const meta = extract(blocks, 3)
    expect(meta.jsonLdCount).toBe(12)
    expect(meta.jsonLd).toHaveLength(3)
    expect(meta.jsonLd.map((block) => block.index)).toEqual([1, 2, 3])
  })

  it('E6 ignores head-scoped tags that carry no usable value', () => {
    const meta = extract('<html lang="de"><head><link rel="canonical" href=""><link rel="alternate"><link rel="stylesheet" href="/a.css">'
      + '<meta property="og:locale" content="de_DE"><meta charset="utf-8"></head>')
    expect(meta.canonical).toBe('')
    expect(meta.alternates).toEqual([])
    expect(meta.icons).toEqual([])
    expect(meta.lang).toBe('de')
    expect(meta.openGraph).toEqual([{ name: 'og:locale', content: 'de_DE' }])
  })

  it('E7 documents the metadata caps', () => {
    expect(MAX_META_TEXT).toBe(1_000)
    expect(MAX_HEAD_SCAN).toBe(200_000)
    expect(MAX_META_REFS).toBe(32)
    expect(MAX_JSON_LD_BLOCKS).toBe(10)
  })

  it('E8 caps the head scan of an unclosed document and flags it', () => {
    const html = '<html><head><meta name="description" content="kept">'
      + '<!--' + 'x'.repeat(200_000) + '-->'
      + '<meta name="robots" content="dropped">'
    expect(html.length).toBeGreaterThan(MAX_HEAD_SCAN)
    const meta = extract(html)
    expect(meta.truncated).toBe(true)
    expect(meta.description).toBe('kept')
    expect(meta.robots).toBe('')
  })
})

describe('web_meta renderer', () => {
  const tools = buildWebfetchTools(resolveConfig({}))
  const render = (value: unknown, url = 'https://x.test/page') =>
    (tools.web_meta.output.render({ url }, value)[0] as { text: string }).text

  it('R1 renders every populated section of a metadata result', () => {
    const text = render({
      url: 'https://x.test/page',
      finalUrl: 'https://x.test/page',
      status: 200,
      title: 'Widget & Co \u2014 Home',
      description: 'Widgets for everyone',
      canonical: 'https://x.test/products/widget',
      lang: 'en-GB',
      charset: 'utf-8',
      robots: 'index,follow',
      author: 'A. Author',
      openGraph: [{ name: 'og:title', content: 'Widget & Co' }, { name: 'og:image', content: '/img/hero.png' }],
      twitter: [{ name: 'twitter:card', content: 'summary_large_image' }],
      alternates: [{ hreflang: 'en', href: 'https://x.test/en/widget' }],
      feeds: [{ type: 'application/rss+xml', title: 'Blog feed', href: 'https://x.test/feed.xml' }],
      icons: ['https://x.test/favicon.ico'],
      jsonLd: [
        { index: 1, valid: true, types: ['Product'] },
        { index: 2, valid: false, types: [], error: 'Unexpected token' },
      ],
      jsonLdCount: 3,
      jsonLdInvalid: 1,
      truncated: false,
    })
    expect(text.split('\n')[0]).toBe('HTTP 200 \u2014 metadata of https://x.test/page')
    expect(text).toContain('title: Widget & Co \u2014 Home')
    expect(text).toContain('lang: en-GB \u2014 charset: utf-8')
    expect(text).toContain('open graph (2):')
    expect(text).toContain('  og:image \u2014 /img/hero.png')
    expect(text).toContain('twitter (1):')
    expect(text).toContain('hreflang alternates (1):')
    expect(text).toContain('feeds (1):')
    expect(text).toContain('  application/rss+xml \u2014 Blog feed \u2014 https://x.test/feed.xml')
    expect(text).toContain('icons (1):')
    expect(text).toContain('json-ld: 3 block(s) (1 invalid)')
    expect(text).toContain('  1. Product')
    expect(text).toContain('  2. invalid \u2014 Unexpected token')
  })

  it('R2 renders a bare metadata result without inventing sections', () => {
    const text = render({
      url: 'https://x.test/',
      finalUrl: 'https://x.test/',
      status: 200,
      title: '',
      description: '',
      canonical: '',
      lang: '',
      charset: '',
      robots: '',
      author: '',
      openGraph: [],
      twitter: [],
      alternates: [],
      feeds: [],
      icons: [],
      jsonLd: [],
      jsonLdCount: 0,
      jsonLdInvalid: 0,
      truncated: false,
    })
    expect(text).toBe('HTTP 200 \u2014 metadata of https://x.test/\njson-ld: 0 block(s)')
  })

  it('R3 notes a redirect and a block without @type', () => {
    const text = render({
      url: 'https://x.test/old',
      finalUrl: 'https://x.test/new',
      status: 200,
      title: '',
      description: '',
      canonical: '',
      lang: '',
      charset: '',
      robots: '',
      author: '',
      openGraph: [],
      twitter: [],
      alternates: [],
      feeds: [],
      icons: [],
      jsonLd: [{ index: 1, valid: true, types: [] }],
      jsonLdCount: 1,
      jsonLdInvalid: 0,
      truncated: false,
    })
    expect(text.split('\n')[0]).toBe('HTTP 200 (redirected from https://x.test/old) \u2014 metadata of https://x.test/new')
    expect(text).toContain('  1. (no @type)')
  })
})

describe('web_meta end-to-end (fixture server)', () => {
  let server: Server
  let base: string

  interface MetaResult {
    url: string
    finalUrl: string
    status: number
    title: string
    description: string
    canonical: string
    lang: string
    charset: string
    robots: string
    author: string
    openGraph: Array<{ name: string; content: string }>
    twitter: Array<{ name: string; content: string }>
    alternates: Array<{ hreflang: string; href: string }>
    feeds: Array<{ type: string; title: string; href: string }>
    icons: string[]
    jsonLd: Array<{ index: number; valid: boolean; types: string[]; error?: string }>
    jsonLdCount: number
    jsonLdInvalid: number
    truncated: boolean
  }
  type MetaArgs = { url: string; maxJsonLd?: number }
  const metaRun = (url: string, args: Partial<MetaArgs> = {}) => {
    const tools = buildWebfetchTools(resolveConfig({}, {}))
    const run = tools.web_meta.execute as (args: MetaArgs) => Promise<MetaResult>
    return run({ url, ...args })
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(META_FIXTURE)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('failed to bind fixture server')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('extracts metadata through the execute path and resolves every href', async () => {
    const result = await metaRun(`${base}/page`)
    expect(result.status).toBe(200)
    expect(result.title).toBe('Widget & Co \u2014 Home')
    expect(result.canonical).toBe(`${base}/products/widget`)
    expect(result.alternates).toEqual([
      { hreflang: 'en', href: `${base}/en/widget` },
      { hreflang: 'zh-Hans', href: `${base}/zh/widget` },
    ])
    expect(result.feeds.map((feed) => feed.href)).toEqual([`${base}/feed.xml`, `${base}/atom.xml`])
    expect(result.icons).toEqual([`${base}/favicon.ico`, `${base}/apple-touch-icon.png`])
    expect(result.openGraph).toHaveLength(4)
    expect(result.twitter).toHaveLength(2)
    expect(result.jsonLdCount).toBe(3)
    expect(result.jsonLdInvalid).toBe(1)
  })

  it('clamps maxJsonLd into the accepted range', async () => {
    const clamped = await metaRun(`${base}/page`, { maxJsonLd: 0 })
    expect(clamped.jsonLdCount).toBe(3)
    expect(clamped.jsonLd).toHaveLength(1)
    const limited = await metaRun(`${base}/page`, { maxJsonLd: 2 })
    expect(limited.jsonLdCount).toBe(3)
    expect(limited.jsonLd).toHaveLength(2)
  })

  it('keeps the web_meta payload free of undefined values', () => {
    const assertNoUndefined = (value: unknown, path = 'result'): void => {
      if (value === undefined) throw new Error(`undefined value at ${path}`)
      if (Array.isArray(value)) value.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`))
      else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) assertNoUndefined(inner, `${path}.${key}`)
      }
    }
    return metaRun(`${base}/page`).then(assertNoUndefined)
  })

  it('reports a rejected fetch for a missing page instead of inventing metadata', async () => {
    await expect(metaRun(`${base}/missing`)).rejects.toThrow()
  })
})
