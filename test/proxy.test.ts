/**
 * Tests for the zero-dependency proxy layer: NO_PROXY matching, proxy
 * selection, response-head/framing parsing, and end-to-end proxied http
 * fetching against a local fake proxy fixture (no external network).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  decodeChunked,
  framingOf,
  inCidr,
  parseHead,
  proxiedFetch,
  proxyFor,
  resolveProxyConf,
  shouldBypass,
} from '../src/proxy.ts'

describe('resolveProxyConf', () => {
  it('reads env vars case-insensitively', () => {
    expect(resolveProxyConf({ HTTP_PROXY: 'http://p:1', https_proxy: 'http://p:2', NO_PROXY: 'a,b' }, {})).toEqual({
      httpProxy: 'http://p:1',
      httpsProxy: 'http://p:2',
      noProxy: 'a,b',
    })
  })

  it('prefers explicit config and treats empty string as disable', () => {
    expect(resolveProxyConf({ HTTP_PROXY: 'http://env:1' }, { httpProxy: '' })).toEqual({
      httpProxy: '',
      httpsProxy: '',
      noProxy: '',
    })
  })

  it('is fully empty without env or config', () => {
    expect(resolveProxyConf({}, {})).toEqual({ httpProxy: '', httpsProxy: '', noProxy: '' })
  })
})

describe('shouldBypass', () => {
  it('handles exact, suffix, wildcard and port-stripped entries', async () => {
    const list = 'example.com, .local, *.internal, api.test.com:8080'
    expect(await shouldBypass('example.com', list)).toBe(true)
    expect(await shouldBypass('sub.example.com', list)).toBe(true)
    expect(await shouldBypass('myhost.local', list)).toBe(true)
    expect(await shouldBypass('x.internal', list)).toBe(true)
    expect(await shouldBypass('api.test.com', list)).toBe(true)
    expect(await shouldBypass('other.org', list)).toBe(false)
  })

  it('supports the global * entry', async () => {
    expect(await shouldBypass('anything.example', '*')).toBe(true)
  })

  it('matches IPv4 CIDR entries against literal hosts without DNS', async () => {
    expect(await shouldBypass('10.1.2.3', '10.0.0.0/8')).toBe(true)
    expect(await shouldBypass('192.168.1.1', '10.0.0.0/8,192.168.0.0/16')).toBe(true)
    expect(await shouldBypass('172.20.0.1', '10.0.0.0/8,192.168.0.0/16')).toBe(false)
  })

  it('matches CIDR entries against hostnames via local DNS', async () => {
    expect(await shouldBypass('localhost', '127.0.0.0/8')).toBe(true)
  })

  it('returns false for an empty list', async () => {
    expect(await shouldBypass('example.com', '')).toBe(false)
  })
})

describe('inCidr', () => {
  it('evaluates membership and rejects malformed input', () => {
    expect(inCidr('10.0.0.5', '10.0.0.0/8')).toBe(true)
    expect(inCidr('11.0.0.5', '10.0.0.0/8')).toBe(false)
    expect(inCidr('10.0.0.5', '10.0.0.0/32')).toBe(false)
    expect(inCidr('10.0.0.5', '10.0.0.5/32')).toBe(true)
    expect(inCidr('10.0.0.5', 'nonsense')).toBe(false)
    expect(inCidr('300.1.1.1', '10.0.0.0/8')).toBe(false)
  })
})

describe('proxyFor', () => {
  const conf = { httpProxy: 'http://p:7897', httpsProxy: 'http://p:7897', noProxy: '' }

  it('selects the proxy for http and https targets', async () => {
    const http = await proxyFor(new URL('http://example.com/'), conf)
    expect(http.proxy?.hostname).toBe('p')
    const https = await proxyFor(new URL('https://example.com/'), conf)
    expect(https.proxy?.port).toBe('7897')
  })

  it('bypasses for NO_PROXY matches', async () => {
    const decision = await proxyFor(new URL('http://127.0.0.1/x'), { ...conf, noProxy: '127.0.0.1' })
    expect(decision.proxy).toBeNull()
  })

  it('goes direct when no proxy is configured', async () => {
    const decision = await proxyFor(new URL('https://example.com/'), { httpProxy: '', httpsProxy: '', noProxy: '' })
    expect(decision.proxy).toBeNull()
  })

  it('rejects unsupported proxy protocols', async () => {
    await expect(proxyFor(new URL('http://example.com/'), { ...conf, httpProxy: 'socks5://p:1080' })).rejects.toThrow(/only http proxies/)
  })
})

describe('parseHead / framingOf / decodeChunked', () => {
  it('parses a status line and headers (lowercased, duplicates joined)', () => {
    const result = parseHead(Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-A: 1\r\nx-a: 2\r\n\r\n'))
    expect(result.status).toBe(200)
    expect(result.statusText).toBe('OK')
    expect(result.headers.get('content-type')).toBe('text/html')
    expect(result.headers.get('x-a')).toBe('1, 2')
  })

  it('rejects a malformed head', () => {
    expect(() => parseHead(Buffer.from('not http\r\n\r\n'))).toThrow(/malformed HTTP response head/)
  })

  it('detects framing from headers', () => {
    expect(framingOf(new Map([['content-length', '42']]))).toEqual({ kind: 'length', n: 42 })
    expect(framingOf(new Map([['transfer-encoding', 'chunked']]))).toEqual({ kind: 'chunked' })
    expect(framingOf(new Map<string, string>())).toEqual({ kind: 'close' })
  })

  it('decodes chunked bodies', () => {
    const raw = Buffer.from('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n')
    expect(decodeChunked(raw).toString()).toBe('hello world')
  })
})

describe('proxiedFetch through a local http proxy fixture', () => {
  let server: Server
  let proxyBase: string
  const seen: string[] = []

  beforeAll(async () => {
    // Minimal "proxy": accepts absolute-URI GET requests (as a real forward
    // proxy receives for plain http) and answers with the fixture content.
    server = createServer((req, res) => {
      seen.push(req.url ?? '')
      if (req.headers['proxy-authorization'] === 'Basic dXNlcjpwYXNz') {
        seen.push('auth-ok')
      }
      if (req.url === 'http://example.test/chunked') {
        // no content-length -> Node applies chunked transfer-encoding itself
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('hello')
        res.end(' world')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '13' })
      res.end('hello, proxy!')
    })
    // CONNECT requests arrive on the 'connect' event, not 'request'.
    server.on('connect', (req, socket) => {
      seen.push('CONNECT ' + (req.url ?? ''))
      socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      socket.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('failed to bind proxy fixture')
    proxyBase = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const options = (signal = AbortSignal.timeout(5_000)) => ({
    timeoutMs: 5_000,
    maxBytes: 100_000,
    signal,
    headers: { 'user-agent': 'probe/1.0' },
  })

  it('fetches a plain http target through the proxy (absolute-URI form)', async () => {
    const response = await proxiedFetch(new URL('http://example.test/path?q=1'), new URL(proxyBase), options())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello, proxy!')
    expect(seen[0]).toBe('http://example.test/path?q=1')
  })

  it('sends Proxy-Authorization when the proxy URL carries credentials', async () => {
    const proxyWithAuth = new URL(proxyBase)
    proxyWithAuth.username = 'user'
    proxyWithAuth.password = 'pass'
    const response = await proxiedFetch(new URL('http://example.test/'), proxyWithAuth, options())
    expect(response.status).toBe(200)
    expect(seen).toContain('auth-ok')
  })

  it('decodes chunked transfer bodies', async () => {
    const response = await proxiedFetch(new URL('http://example.test/chunked'), new URL(proxyBase), options())
    expect(await response.text()).toBe('hello world')
  })

  it('surfaces proxy CONNECT failure statuses clearly', async () => {
    const url = new URL('https://example.test/x')
    await expect(proxiedFetch(url, new URL(proxyBase), options())).rejects.toThrow(/CONNECT failed: HTTP 407/)
    expect(seen).toContain('CONNECT example.test:443')
  })

  it('aborts when the signal fires', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      proxiedFetch(new URL('http://example.test/'), new URL(proxyBase), options(controller.signal)),
    ).rejects.toThrow(/aborted/)
  })
})
