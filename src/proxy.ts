/**
 * Zero-dependency HTTP(S) proxy support for dsh-webfetch.
 *
 * Node's global fetch ignores HTTP_PROXY/HTTPS_PROXY, which makes every
 * request fail on networks that require a proxy (direct connections are
 * blocked). This module implements a minimal HTTP proxy transport on top of
 * node:net + node:tls — CONNECT tunnelling for https targets, absolute-URI
 * form for http targets — with NO_PROXY matching (exact, suffix, wildcard
 * and IPv4 CIDR). No third-party packages, no credentials are persisted.
 *
 * @module dsh-webfetch/proxy
 */

import net from 'node:net'
import tls from 'node:tls'
import { lookup } from 'node:dns/promises'

/** Proxy-related configuration resolved from env and plugin config. */
export interface ProxyConf {
  /** http proxy URL (http://host:port); '' = connect directly. */
  httpProxy: string
  /** https proxy URL; '' = connect directly. */
  httpsProxy: string
  /** NO_PROXY list (comma-separated); '' = no bypass entries. */
  noProxy: string
}

/** Read the first present environment variable of the given names. */
function firstEnv(env: Record<string, string | undefined>, names: string[]): string {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value !== '') return value
  }
  return ''
}

/** Resolve proxy configuration: explicit config wins, then env, '' = disabled. */
export function resolveProxyConf(env: Record<string, string | undefined>, overrides: { httpProxy?: string; httpsProxy?: string; noProxy?: string }): ProxyConf {
  return {
    httpProxy: overrides.httpProxy ?? firstEnv(env, ['HTTP_PROXY', 'http_proxy']),
    httpsProxy: overrides.httpsProxy ?? firstEnv(env, ['HTTPS_PROXY', 'https_proxy']),
    noProxy: overrides.noProxy ?? firstEnv(env, ['NO_PROXY', 'no_proxy']),
  }
}

/** Strip a ":port" suffix from a NO_PROXY entry (hostnames only). */
function stripPort(entry: string): string {
  const match = /^(\[[^\]]+\]|[^:]+):\d+$/.exec(entry)
  return match?.[1] === undefined ? entry : match[1]
}

/** Parse an IPv4 literal into 4 octets, or null when not a valid IPv4. */
function ipv4Parts(value: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (match === null) return null
  const parts = [match[1], match[2], match[3], match[4]].map(Number)
  if (parts.some((part) => part > 255)) return null
  return parts
}

/** Check whether an IPv4 address falls inside a CIDR entry (a.b.c.d/n). */
export function inCidr(address: string, entry: string): boolean {
  const slash = entry.indexOf('/')
  if (slash === -1) return false
  const network = entry.slice(0, slash)
  const bits = Number(entry.slice(slash + 1))
  const addr = ipv4Parts(address)
  const netp = ipv4Parts(network)
  if (addr === null || netp === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const toInt = (p: number[]) => (((p[0] ?? 0) << 24) | ((p[1] ?? 0) << 16) | ((p[2] ?? 0) << 8) | (p[3] ?? 0)) >>> 0
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return ((toInt(addr) & mask) >>> 0) === ((toInt(netp) & mask) >>> 0)
}

/** Decide whether a hostname should bypass the proxy (NO_PROXY semantics). */
export async function shouldBypass(hostname: string, noProxyList: string): Promise<boolean> {
  const entries = noProxyList.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '')
  if (entries.includes('*')) return true
  if (entries.length === 0) return false
  const host = hostname.toLowerCase().trim()
  const hostIsIp = ipv4Parts(host) !== null
  const cidrs: string[] = []
  for (const raw of entries) {
    const entry = stripPort(raw)
    if (entry === '') continue
    if (entry.includes('/')) {
      cidrs.push(entry)
      continue
    }
    const plain = entry.startsWith('*.') ? entry.slice(1) : entry
    const matched = plain.startsWith('.') ? host.endsWith(plain) : host === plain || host.endsWith('.' + plain)
    if (matched) return true
  }
  if (cidrs.length > 0) {
    const target = hostIsIp ? host : await lookup(host).then((result) => result.address).catch(() => '')
    for (const cidr of cidrs) {
      if (target !== '' && inCidr(target, cidr)) return true
    }
  }
  return false
}

/** Decide which proxy (if any) applies to a URL. */
export async function proxyFor(url: URL, conf: ProxyConf): Promise<{ proxy: URL | null }> {
  if (await shouldBypass(url.hostname, conf.noProxy)) return { proxy: null }
  const raw = url.protocol === 'https:' ? conf.httpsProxy : conf.httpProxy
  if (raw === '') return { proxy: null }
  let proxy: URL
  try {
    proxy = new URL(raw)
  } catch {
    throw new Error(`invalid proxy URL "${raw}"`)
  }
  if (proxy.protocol !== 'http:') {
    throw new Error(`unsupported proxy protocol "${proxy.protocol}" — only http proxies are supported`)
  }
  return { proxy }
}

/** Options for a proxied request. */
export interface ProxyRequestOptions {
  timeoutMs: number
  maxBytes: number
  signal: AbortSignal
  headers: Record<string, string>
}

interface HeadResult {
  status: number
  statusText: string
  headers: Map<string, string>
}

/** Parse an HTTP response head (status line + headers). */
export function parseHead(head: Buffer): HeadResult {
  const lines = head.toString('latin1').split('\r\n')
  const statusLine = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(lines[0] ?? '')
  if (statusLine === null) throw new Error(`malformed HTTP response head: "${lines[0] ?? ''}"`)
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    const existing = headers.get(key)
    headers.set(key, existing === undefined ? value : existing + ', ' + value)
  }
  return { status: Number(statusLine[1]), statusText: statusLine[2] ?? '', headers }
}

/** Body framing of a response. */
export type Framing = { kind: 'length'; n: number } | { kind: 'chunked' } | { kind: 'close' }

/** Determine body framing from response headers. */
export function framingOf(headers: Map<string, string>): Framing {
  const transferEncoding = (headers.get('transfer-encoding') ?? '').toLowerCase()
  if (transferEncoding.includes('chunked')) return { kind: 'chunked' }
  const contentLength = headers.get('content-length')
  if (contentLength !== undefined && /^\d+$/.test(contentLength)) return { kind: 'length', n: Number(contentLength) }
  return { kind: 'close' }
}

/** Decode a chunked-encoding body into its payload bytes (best effort). */
export function decodeChunked(raw: Buffer): Buffer {
  const out: Buffer[] = []
  let pos = 0
  for (;;) {
    const lineEnd = raw.indexOf('\r\n', pos)
    if (lineEnd === -1) break
    const sizeText = raw.subarray(pos, lineEnd).toString('latin1').split(';')[0]?.trim() ?? ''
    const size = parseInt(sizeText, 16)
    if (!Number.isFinite(size) || size < 0) break
    pos = lineEnd + 2
    if (size === 0) break
    if (pos + size + 2 > raw.length) break
    out.push(raw.subarray(pos, pos + size))
    pos += size + 2
  }
  return Buffer.concat(out)
}

/** Open a TCP connection to the proxy, with a hard timeout. */
function connectSocket(proxy: URL, timeoutMs: number): Promise<net.Socket> {
  const port = proxy.port === '' ? 80 : Number(proxy.port)
  const socket = net.connect({ host: proxy.hostname, port })
  socket.setTimeout(timeoutMs)
  return new Promise<net.Socket>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(new Error(`failed to connect to proxy ${proxy.hostname}:${port}: ${error.message}`))
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.off('error', onError)
      resolve(socket)
    })
  })
}

/** Read a response head from a socket; returns leftover body bytes too. */
function readHead(socket: net.Socket | tls.TLSSocket): Promise<{ head: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
      socket.off('timeout', onTimeout)
    }
    const onData = (chunk: Buffer) => {
      if (settled) return
      chunks.push(chunk)
      total += chunk.length
      const joined = Buffer.concat(chunks)
      const idx = joined.indexOf('\r\n\r\n')
      if (idx !== -1) {
        settled = true
        cleanup()
        socket.pause()
        resolve({ head: joined.subarray(0, idx), rest: joined.subarray(idx + 4) })
        return
      }
      if (total > 64_000) {
        settled = true
        cleanup()
        reject(new Error('response head too large'))
      }
    }
    const onError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('connection closed while reading response head'))
    }
    const onTimeout = () => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(new Error('timed out reading response head'))
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.on('timeout', onTimeout)
  })
}

/** Read the response body with a hard cap, decoding per framing. */
function readBody(socket: net.Socket | tls.TLSSocket, framing: Framing, maxBytes: number, rest: Buffer): Promise<Buffer> {
  const cap = maxBytes + 64 * 1024
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
      socket.off('timeout', onTimeout)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      resolve(Buffer.concat(chunks))
    }
    const onData = (chunk: Buffer) => {
      if (settled) return
      chunks.push(chunk)
      total += chunk.length
      if (framing.kind === 'length' && total >= framing.n) finish()
      if (total > cap) finish()
    }
    const onError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onEnd = () => finish()
    const onTimeout = () => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(new Error('timed out reading response body'))
    }
    if (rest.length > 0) {
      chunks.push(rest)
      total = rest.length
      if (framing.kind === 'length' && total >= framing.n) {
        socket.destroy()
        resolve(Buffer.concat(chunks))
        return
      }
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.on('timeout', onTimeout)
    socket.resume()
  })
}

/** Build a Proxy-Authorization header value when the proxy URL carries credentials. */
function proxyAuth(proxy: URL): string {
  const user = decodeURIComponent(proxy.username)
  if (user === '') return ''
  const pass = decodeURIComponent(proxy.password)
  return `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/** Establish a CONNECT tunnel to an https target through the proxy. */
async function tunnelHttps(target: URL, proxy: URL, timeoutMs: number): Promise<tls.TLSSocket> {
  const socket = await connectSocket(proxy, timeoutMs)
  const port = target.port === '' ? 443 : target.port
  const auth = proxyAuth(proxy)
  const authLine = auth === '' ? '' : `${auth}\r\n`
  socket.write(`CONNECT ${target.hostname}:${port} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\n${authLine}\r\n`)
  const { head, rest } = await readHead(socket)
  const result = parseHead(head)
  if (result.status !== 200) {
    socket.destroy()
    throw new Error(`proxy CONNECT failed: HTTP ${result.status} ${result.statusText} at ${proxy.hostname}`)
  }
  if (rest.length > 0) socket.unshift(rest)
  const tlsSocket = tls.connect({ socket, servername: target.hostname })
  tlsSocket.setTimeout(timeoutMs)
  return tlsSocket
}

/**
 * Fetch a URL through an http proxy, returning a standard Response object.
 * Supports https via CONNECT tunnelling (TLS to the target, verified against
 * the system trust store) and http via the absolute-URI request form.
 */
export async function proxiedFetch(target: URL, proxy: URL, options: ProxyRequestOptions): Promise<Response> {
  const isHttps = target.protocol === 'https:'
  const socket = isHttps
    ? await tunnelHttps(target, proxy, options.timeoutMs)
    : await connectSocket(proxy, options.timeoutMs)

  const onAbort = () => socket.destroy()
  if (options.signal.aborted) {
    socket.destroy()
    throw new Error('request aborted')
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  try {
    const port = target.port === '' ? (isHttps ? 443 : 80) : target.port
    const requestTarget = isHttps ? `${target.pathname}${target.search}` : target.href
    const auth = proxyAuth(proxy)
    const headerLines = [`Host: ${target.hostname}:${port}`]
    if (!isHttps && auth !== '') headerLines.push(auth)
    for (const [key, value] of Object.entries(options.headers)) headerLines.push(`${key}: ${value}`)
    socket.write(`GET ${requestTarget} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\nConnection: close\r\n\r\n`)

    const { head, rest } = await readHead(socket)
    const result = parseHead(head)
    const framing = framingOf(result.headers)
    const raw = await readBody(socket, framing, options.maxBytes, rest)
    const bodyBuffer = framing.kind === 'chunked'
      ? decodeChunked(raw)
      : framing.kind === 'length' ? raw.subarray(0, framing.n) : raw

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (bodyBuffer.length > 0) controller.enqueue(new Uint8Array(bodyBuffer))
        controller.close()
      },
      cancel() {
        socket.destroy()
      },
    })
    return new Response(stream, { status: result.status, statusText: result.statusText, headers: Object.fromEntries(result.headers) })
  } finally {
    options.signal.removeEventListener('abort', onAbort)
  }
}
