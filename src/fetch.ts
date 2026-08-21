/**
 * HTTP layer for dsh-webfetch: validates URLs, follows a bounded number of
 * redirects (http/https only), caps the response size, detects the charset
 * and returns the decoded document.
 *
 * Direct requests use the global fetch (Node >= 20); when an http proxy is
 * configured (explicitly or via HTTP_PROXY/HTTPS_PROXY env) and the target is
 * not excluded by NO_PROXY, a zero-dependency proxy transport is used instead
 * (see proxy.ts). No credentials, cookies or custom headers are ever
 * attached beyond a plain user-agent, and credentials embedded in URLs are
 * rejected.
 *
 * @module dsh-webfetch/fetch
 */

import { proxyFor, proxiedFetch, type ProxyConf } from './proxy.ts'

/** Runtime configuration used by the HTTP layer. */
export interface FetchConfig {
  /** Per-request timeout in ms. */
  timeoutMs: number
  /** Maximum accepted response body size in bytes (before decoding). */
  maxBytes: number
  /** Maximum number of redirects to follow. */
  maxRedirects: number
  /** User-Agent header value. */
  userAgent: string
  /** Proxy selection configuration ('' = connect directly). */
  proxy: ProxyConf
}

/** A validated http/https URL string. */
export function assertHttpUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error(`invalid URL: "${input}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported protocol "${url.protocol}" — only http and https are allowed`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('URLs with embedded credentials are rejected (privacy)')
  }
  return url.toString()
}

/** Result of a fetch: raw document plus metadata. */
export interface FetchedPage {
  /** The URL the final response was served from (after redirects). */
  finalUrl: string
  status: number
  contentType: string
  /** Decoded document text (HTML or plain text). */
  body: string
  /** True when the body exceeded maxBytes and was cut off. */
  truncated: boolean
}

/** Detect the charset: Content-Type header, then XML declaration / <meta> sniffing. */
function detectCharset(headers: Headers, bodyBuffer: Buffer): string {
  const header = headers.get('content-type') ?? ''
  const headerMatch = /charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i.exec(header)
  if (headerMatch?.[1] !== undefined) return headerMatch[1]

  // Only sniff the first 2 KB of the document for declaration or meta tags.
  const head = bodyBuffer.subarray(0, 2048).toString('latin1')
  const xmlMatch = /<\?xml[^>]+encoding\s*=\s*["']([a-zA-Z0-9._-]+)/i.exec(head)
  if (xmlMatch?.[1] !== undefined) return xmlMatch[1]
  const metaMatch = /<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i.exec(head)
    ?? /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9._-]+)/i.exec(head)
  return metaMatch?.[1] ?? 'utf-8'
}

/** Decode a body buffer with the given charset label, falling back to utf-8. */
function decodeBody(buffer: Buffer, charset: string): string {
  if (charset.toLowerCase().replace(/[_-]/g, '') === 'utf8') return buffer.toString('utf8')
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

/** Content types accepted when reading web pages. */
const PAGE_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain'])

/** Content types accepted when reading syndication feeds (pages allowed too). */
const FEED_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'text/plain',
  'application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml',
])

/**
 * Fetch a URL and return the decoded document. Throws on invalid URLs,
 * disallowed content types, timeouts, redirect loops, DNS/network failures
 * and non-2xx statuses (with the status in the message).
 */
async function fetchDocument(input: string, config: FetchConfig, allowed: ReadonlySet<string>, typeHint: string): Promise<FetchedPage> {
  let current = assertHttpUrl(input)

  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    const target = new URL(current)
    const decision = await proxyFor(target, config.proxy)
    const signal = AbortSignal.timeout(config.timeoutMs)
    const headers = {
      'user-agent': config.userAgent,
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
    }
    let response: Response
    try {
      response = decision.proxy === null
        ? await fetch(target, { redirect: 'manual', signal, headers })
        : await proxiedFetch(target, decision.proxy, { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, signal, headers })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`timed out after ${config.timeoutMs} ms fetching ${current}`)
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`timed out after ${config.timeoutMs} ms fetching ${current}`)
      }
      throw new Error(`fetch failed for ${current}: ${error instanceof Error ? error.message : String(error)}`)
    }

    const status = response.status
    const location = response.headers.get('location')

    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      await response.body?.cancel().catch(() => {})
      if (location === null || location === '') {
        throw new Error(`HTTP ${status} redirect from ${current} without a Location header`)
      }
      if (hop === config.maxRedirects) {
        throw new Error(`too many redirects (limit ${config.maxRedirects}) fetching ${input}`)
      }
      current = assertHttpUrl(new URL(location, current).toString())
      continue
    }

    if (status < 200 || status >= 300) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${status} ${response.statusText} for ${current}`)
    }

    const contentType = (response.headers.get('content-type') ?? 'unknown').split(';')[0]?.trim().toLowerCase() ?? 'unknown'
    if (!allowed.has(contentType)) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`unsupported content type "${contentType}" at ${current} — ${typeHint}`)
    }

    // Stream the body with a hard size cap; abort early when it blows up.
    const chunks: Buffer[] = []
    let total = 0
    let truncated = false
    const reader = response.body?.getReader()
    if (reader !== undefined) {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > config.maxBytes) {
            truncated = true
            const remaining = value.byteLength - (total - config.maxBytes)
            if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)))
            await reader.cancel().catch(() => {})
            break
          }
          chunks.push(Buffer.from(value))
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new Error(`timed out after ${config.timeoutMs} ms reading ${current}`)
        }
        throw new Error(`failed reading body from ${current}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const bodyBuffer = Buffer.concat(chunks)
    const charset = detectCharset(response.headers, bodyBuffer)

    return {
      finalUrl: current,
      status,
      contentType,
      body: decodeBody(bodyBuffer, charset),
      truncated,
    }
  }

  // Unreachable: the loop above always returns or throws.
  throw new Error(`unreachable redirect loop for ${input}`)
}

/** Fetch a web page (HTML or plain text only). */
export async function fetchPage(input: string, config: FetchConfig): Promise<FetchedPage> {
  return fetchDocument(input, config, PAGE_TYPES, 'this tool reads HTML and plain text pages only')
}

/** Fetch a syndication feed document (RSS/Atom/XML; HTML pages allowed too). */
export async function fetchFeed(input: string, config: FetchConfig): Promise<FetchedPage> {
  return fetchDocument(input, config, FEED_TYPES, 'expected an HTML/plain-text page or an RSS/Atom/XML feed')
}

/** Resolve a possibly-relative href against a base page URL. */
export function resolveHref(href: string, baseUrl: string): string {
  const cleaned = href.trim()
  if (cleaned === '' || cleaned.startsWith('#') || cleaned.startsWith('javascript:')
    || cleaned.startsWith('mailto:') || cleaned.startsWith('tel:') || cleaned.startsWith('data:')) {
    return ''
  }
  try {
    const url = new URL(cleaned, baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.toString()
  } catch {
    return ''
  }
}
