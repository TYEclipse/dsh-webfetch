/**
 * Tests for the header-probing layer (web_headers): HEAD/GET probes,
 * automatic HEAD→GET fallback, redirect chains and limits, non-2xx
 * reporting, timeout handling, and HEAD through a local http proxy
 * fixture — no external network required.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { probeUrl } from '../src/head.ts'

let server: Server
let base: string

const config = {
  timeoutMs: 5_000,
  maxBytes: 100_000,
  maxRedirects: 3,
  userAgent: 'dsh-webfetch-test/0.1',
  proxy: { httpProxy: '', httpsProxy: '', noProxy: '' },
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    switch (url.pathname) {
      case '/ok':
        res.writeHead(200, 'OK', { 'content-type': 'text/html; charset=utf-8', 'x-custom': 'hello' })
        res.end('<html><body>hi</body></html>')
        break
      case '/no-head':
        if (req.method === 'HEAD') {
          res.writeHead(405, 'Method Not Allowed')
          res.end()
          break
        }
        res.writeHead(200, { 'content-type': 'text/html', 'x-custom': 'via-get' })
        res.end('<html><body>get body</body></html>')
        break
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
      case '/no-location':
        res.writeHead(302)
        res.end()
        break
      case '/offsite':
        res.writeHead(302, { location: 'file:///etc/passwd' })
        res.end()
        break
      case '/missing':
        res.writeHead(404, 'Not Found', { 'content-type': 'text/html' })
        res.end('nope')
        break
      case '/hang':
        // Never responds; the client-side timeout must fire.
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

describe('probeUrl', () => {
  it('returns status, statusText, headers and method for a plain HEAD probe', async () => {
    const result = await probeUrl(`${base}/ok`, config, 'HEAD', true)
    expect(result.status).toBe(200)
    expect(result.statusText).toBe('OK')
    expect(result.method).toBe('HEAD')
    expect(result.headers['content-type']).toContain('text/html')
    expect(result.headers['x-custom']).toBe('hello')
    expect(result.url).toBe(`${base}/ok`)
    expect(result.finalUrl).toBe(`${base}/ok`)
    expect(result.redirects).toEqual([])
  })

  it('falls back to GET automatically when the server answers 405 to HEAD', async () => {
    const result = await probeUrl(`${base}/no-head`, config, 'HEAD', true)
    expect(result.status).toBe(200)
    expect(result.method).toBe('GET (HEAD not supported)')
    expect(result.headers['x-custom']).toBe('via-get')
  })

  it('uses GET explicitly without any fallback note', async () => {
    const result = await probeUrl(`${base}/no-head`, config, 'GET', true)
    expect(result.status).toBe(200)
    expect(result.method).toBe('GET')
  })

  it('follows a redirect chain and reports every hop', async () => {
    const result = await probeUrl(`${base}/chain1`, config, 'HEAD', true)
    expect(result.status).toBe(200)
    expect(result.finalUrl).toBe(`${base}/ok`)
    expect(result.redirects).toEqual([
      { url: `${base}/chain1`, status: 301, location: `${base}/chain2` },
      { url: `${base}/chain2`, status: 302, location: `${base}/ok` },
    ])
  })

  it('reports the redirect status itself when followRedirects is false', async () => {
    const result = await probeUrl(`${base}/redirect`, config, 'HEAD', false)
    expect(result.status).toBe(302)
    expect(result.finalUrl).toBe(`${base}/redirect`)
    expect(result.redirects).toEqual([])
  })

  it('rejects redirect loops over the hop limit', async () => {
    await expect(probeUrl(`${base}/loop`, config, 'HEAD', true)).rejects.toThrow(/too many redirects/)
  })

  it('rejects redirects without a Location header', async () => {
    await expect(probeUrl(`${base}/no-location`, config, 'HEAD', true)).rejects.toThrow(/without a Location header/)
  })

  it('rejects redirects to non-http(s) schemes', async () => {
    await expect(probeUrl(`${base}/offsite`, config, 'HEAD', true)).rejects.toThrow(/only http and https/)
  })

  it('reports non-2xx statuses instead of throwing', async () => {
    const result = await probeUrl(`${base}/missing`, config, 'HEAD', true)
    expect(result.status).toBe(404)
    expect(result.statusText).toBe('Not Found')
  })

  it('rejects invalid URLs and embedded credentials', async () => {
    await expect(probeUrl('not-a-url', config, 'HEAD', true)).rejects.toThrow(/invalid URL/)
    await expect(probeUrl('https://user:pass@example.com/', config, 'HEAD', true)).rejects.toThrow(/embedded credentials/)
  })

  it('times out on unresponsive hosts', async () => {
    const slowConfig = { ...config, timeoutMs: 1_000 }
    await expect(probeUrl(`${base}/hang`, slowConfig, 'HEAD', true)).rejects.toThrow(/timed out after 1000 ms/)
  })
})

describe('probeUrl through a local http proxy fixture', () => {
  let proxyServer: Server
  let proxyBase: string
  const seen: string[] = []

  beforeAll(async () => {
    // Minimal "proxy": answers absolute-URI requests for example.test.
    proxyServer = createServer((req, res) => {
      seen.push(`${req.method} ${req.url ?? ''}`)
      if (req.url === 'http://example.test/probed') {
        res.writeHead(200, { 'content-type': 'text/html', 'x-proxied': 'yes' })
        res.end('proxied body')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
    const address = proxyServer.address()
    if (address === null || typeof address === 'string') throw new Error('failed to bind proxy fixture')
    proxyBase = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()))
  })

  it('sends HEAD through the proxy transport and reports the result', async () => {
    const proxiedConfig = { ...config, proxy: { httpProxy: proxyBase, httpsProxy: '', noProxy: '' } }
    const result = await probeUrl('http://example.test/probed', proxiedConfig, 'HEAD', true)
    expect(result.status).toBe(200)
    expect(result.method).toBe('HEAD')
    expect(result.headers['x-proxied']).toBe('yes')
    expect(seen[0]).toBe('HEAD http://example.test/probed')
  })
})
