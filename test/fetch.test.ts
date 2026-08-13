/**
 * Integration tests for the HTTP layer: a local node:http fixture server
 * exercises fetching, redirects, size caps, content-type gating, status
 * errors and charset handling — no external network required.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { assertHttpUrl, fetchPage } from '../src/fetch.ts'

let server: Server
let base: string

const config = {
  timeoutMs: 5_000,
  maxBytes: 100_000,
  maxRedirects: 3,
  userAgent: 'dsh-webfetch-test/0.1',
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    switch (url.pathname) {
      case '/ok': {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html><head><title>Fixture</title></head><body><p>Hello &amp; goodbye</p></body></html>')
        break
      }
      case '/redirect':
        res.writeHead(302, { location: '/ok' })
        res.end()
        break
      case '/chain1':
        res.writeHead(301, { location: '/chain2' })
        res.end()
        break
      case '/chain2':
        res.writeHead(302, { location: '/ok' })
        res.end()
        break
      case '/loop':
        res.writeHead(302, { location: '/loop' })
        res.end()
        break
      case '/offsite':
        res.writeHead(302, { location: 'file:///etc/passwd' })
        res.end()
        break
      case '/big':
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body>' + 'y'.repeat(500_000) + '</body></html>')
        break
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"hello":"world"}')
        break
      case '/missing':
        res.writeHead(404, 'Not Found', { 'content-type': 'text/html' })
        res.end('<html><body>nope</body></html>')
        break
      case '/latin1': {
        const body = Buffer.from('<html><body>caf\u00e9 na\u00efve</body></html>', 'latin1')
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' })
        res.end(body)
        break
      }
      case '/meta-charset': {
        const body = Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>caf\u00e9</body></html>', 'latin1')
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(body)
        break
      }
      case '/plain':
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('just plain text')
        break
      default:
        res.writeHead(404)
        res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to bind fixture server')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('assertHttpUrl', () => {
  it('accepts http/https URLs and rejects everything else', () => {
    expect(assertHttpUrl('https://example.com/x?y=1')).toBe('https://example.com/x?y=1')
    expect(() => assertHttpUrl('ftp://example.com')).toThrow(/only http and https/)
    expect(() => assertHttpUrl('file:///etc/passwd')).toThrow(/only http and https/)
    expect(() => assertHttpUrl('javascript:alert(1)')).toThrow(/only http and https/)
    expect(() => assertHttpUrl('not a url')).toThrow(/invalid URL/)
    expect(() => assertHttpUrl('https://user:secret@example.com/')).toThrow(/credentials/)
  })
})

describe('fetchPage', () => {
  it('fetches and decodes an HTML page', async () => {
    const page = await fetchPage(`${base}/ok`, config)
    expect(page.status).toBe(200)
    expect(page.contentType).toBe('text/html')
    expect(page.finalUrl).toBe(`${base}/ok`)
    expect(page.body).toContain('Hello &amp; goodbye')
    expect(page.truncated).toBe(false)
  })

  it('follows redirects and reports the final URL', async () => {
    const page = await fetchPage(`${base}/redirect`, config)
    expect(page.status).toBe(200)
    expect(page.finalUrl).toBe(`${base}/ok`)
  })

  it('follows multi-hop chains', async () => {
    const page = await fetchPage(`${base}/chain1`, config)
    expect(page.finalUrl).toBe(`${base}/ok`)
  })

  it('rejects redirect loops with a clear error', async () => {
    await expect(fetchPage(`${base}/loop`, config)).rejects.toThrow(/too many redirects/)
  })

  it('rejects redirects to non-http protocols', async () => {
    await expect(fetchPage(`${base}/offsite`, config)).rejects.toThrow(/unsupported protocol/)
  })

  it('caps oversized bodies and flags truncation', async () => {
    const page = await fetchPage(`${base}/big`, config)
    expect(page.truncated).toBe(true)
    expect(page.body.length).toBeLessThanOrEqual(100_000)
  })

  it('rejects non-HTML content types', async () => {
    await expect(fetchPage(`${base}/json`, config)).rejects.toThrow(/unsupported content type/)
  })

  it('surfaces HTTP error statuses', async () => {
    await expect(fetchPage(`${base}/missing`, config)).rejects.toThrow(/HTTP 404/)
  })

  it('honours the charset from the Content-Type header', async () => {
    const page = await fetchPage(`${base}/latin1`, config)
    expect(page.body).toContain('caf\u00e9 na\u00efve')
  })

  it('falls back to meta charset sniffing', async () => {
    const page = await fetchPage(`${base}/meta-charset`, config)
    expect(page.body).toContain('caf\u00e9')
  })

  it('passes plain text through', async () => {
    const page = await fetchPage(`${base}/plain`, config)
    expect(page.body).toBe('just plain text')
  })

  it('times out with a clear error (unroutable address)', async () => {
    await expect(
      fetchPage('https://10.255.255.1/', { ...config, timeoutMs: 500 }),
    ).rejects.toThrow(/timed out|fetch failed/)
  })
})
