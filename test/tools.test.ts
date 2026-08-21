/**
 * Tests for tool definition assembly, config resolution, renderers and an
 * end-to-end web_feed execution against a local fixture server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resolveConfig } from '../src/index.ts'
import { buildWebfetchTools } from '../src/tools.ts'

describe('resolveConfig', () => {
  it('applies every default', () => {
    const resolved = resolveConfig({})
    expect(resolved).toEqual({
      timeoutMs: 10_000,
      maxBytes: 1_500_000,
      maxChars: 50_000,
      maxRedirects: 3,
      userAgent: 'dsh-webfetch/0.2 (DeepSeek Harness plugin)',
    })
  })

  it('honours overrides', () => {
    const resolved = resolveConfig({ timeoutMs: 2_000, maxRedirects: 5, maxChars: 10_000 })
    expect(resolved.timeoutMs).toBe(2_000)
    expect(resolved.maxRedirects).toBe(5)
    expect(resolved.maxChars).toBe(10_000)
    expect(resolved.maxBytes).toBe(1_500_000)
  })
})

describe('buildWebfetchTools', () => {
  const tools = buildWebfetchTools(resolveConfig({}))

  it('exposes all three tools under their canonical names', () => {
    expect(Object.keys(tools).sort()).toEqual(['web_feed', 'web_fetch', 'web_links'])
  })

  it('gives every tool a name, description, schema and executable', () => {
    for (const [key, definition] of Object.entries(tools)) {
      expect(definition.name).toBe(key)
      expect(definition.description.length).toBeGreaterThan(20)
      expect(definition.parameters).toBeDefined()
      expect(definition.output.schema).toBeDefined()
      expect(typeof definition.execute).toBe('function')
    }
  })

  it('renders a fetch result as text with title and content', () => {
    const block = tools.web_fetch.output.render(
      { url: 'https://x.test/' },
      {
        url: 'https://x.test/',
        finalUrl: 'https://x.test/',
        status: 200,
        title: 'Example',
        content: 'body text',
        truncated: false,
      },
    )
    expect(block[0]).toEqual({ type: 'text', text: 'HTTP 200 — title: Example\nbody text' })
  })

  it('renders a links result with the inventory', () => {
    const block = tools.web_links.output.render(
      { url: 'https://x.test/' },
      {
        url: 'https://x.test/',
        finalUrl: 'https://x.test/',
        status: 200,
        count: 1,
        links: [{ text: 'Home', href: 'https://x.test/home' }],
      },
    )
    expect(block[0]?.type).toBe('text')
    const textBlock = block[0] as { type: 'text'; text: string }
    expect(textBlock.text).toContain('Home — https://x.test/home')
  })

  it('renders a feed result as an entry listing', () => {
    const block = tools.web_feed.output.render(
      { url: 'https://x.test/feed.xml' },
      {
        url: 'https://x.test/feed.xml',
        finalUrl: 'https://x.test/feed.xml',
        status: 200,
        feedTitle: 'Example Feed',
        entryCount: 1,
        truncated: false,
        entries: [{ title: 'Post', url: 'https://x.test/post', published: 'Mon, 01 Jan 2024 10:00:00 GMT', summary: 'Short summary' }],
      },
    )
    expect(block[0]?.type).toBe('text')
    const textBlock = block[0] as { type: 'text'; text: string }
    expect(textBlock.text).toBe('feed: Example Feed\n1 entry from https://x.test/feed.xml\n1. Post — https://x.test/post\n   published: Mon, 01 Jan 2024 10:00:00 GMT\n   Short summary')
  })
})

describe('web_feed end-to-end (fixture server)', () => {
  let server: Server
  let base: string

  /** Typed single-argument view of the tool (ToolDefinition.execute takes (args, exec)). */
  interface FeedResult {
    url: string
    finalUrl: string
    status: number
    feedTitle: string
    entryCount: number
    truncated: boolean
    entries: Array<{ title: string; url: string; published?: string; author?: string; summary?: string; content?: string }>
  }
  type FeedArgs = { url: string; maxItems?: number; includeContent?: boolean }
  const feedRun = (url: string, args: Partial<FeedArgs> = {}) => {
    const tools = buildWebfetchTools(resolveConfig({}))
    const run = tools.web_feed.execute as (args: FeedArgs) => Promise<FeedResult>
    return run({ url, ...args })
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/feed') {
        res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
        res.end(
          '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0">'
          + '<channel><title>Fixture Feed</title>'
          + '<item><title>Alpha &amp; beta</title><link>/posts/alpha</link><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate><description>One &mdash; two</description></item>'
          + '<item><title>Second</title><link>/posts/second</link><description>Another</description></item>'
          + '</channel></rss>',
        )
        return
      }
      if (url.pathname === '/not-a-feed') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body><p>just a page</p></body></html>')
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

  it('parses a live RSS feed through the execute path', async () => {
    const result = await feedRun(`${base}/feed`, { maxItems: 1 })
    expect(result).toEqual({
      url: `${base}/feed`,
      finalUrl: `${base}/feed`,
      status: 200,
      feedTitle: 'Fixture Feed',
      entryCount: 1,
      truncated: false,
      entries: [{
        title: 'Alpha & beta',
        url: `${base}/posts/alpha`,
        published: 'Mon, 01 Jan 2024 10:00:00 GMT',
        summary: 'One — two',
      }],
    })
  })

  it('resolves relative entry links against the final feed URL', async () => {
    const result = await feedRun(`${base}/feed`, { maxItems: 2 })
    expect(result.entryCount).toBe(2)
    expect(result.entries[1]?.url).toBe(`${base}/posts/second`)
    expect(result.entries[1]?.published).toBeUndefined()
  })

  it('rejects a non-feed document with a clear error', async () => {
    await expect(feedRun(`${base}/not-a-feed`)).rejects.toThrow(/not a recognized RSS or Atom feed/)
  })

  it('rejects an unsupported protocol before any fetch', async () => {
    await expect(feedRun('file:///etc/passwd')).rejects.toThrow(/only http and https/)
  })
})
