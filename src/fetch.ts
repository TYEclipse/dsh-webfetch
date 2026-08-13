/**
 * HTTP layer for dsh-webfetch: validates URLs, follows a bounded number of
 * redirects (http/https only), caps the response size, detects the charset
 * and returns the decoded document.
 *
 * Uses the global fetch (Node >= 20). No credentials, cookies or custom
 * headers are ever attached, and credentials embedded in URLs are rejected.
 *
 * @module dsh-webfetch/fetch
 */

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

/** Detect the charset: Content-Type header first, then <meta charset> sniffing. */
function detectCharset(headers: Headers, bodyBuffer: Buffer): string {
  const header = headers.get('content-type') ?? ''
  const headerMatch = /charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i.exec(header)
  if (headerMatch?.[1] !== undefined) return headerMatch[1]

  // Only sniff the first 2 KB of the document for meta declarations.
  const head = bodyBuffer.subarray(0, 2048).toString('latin1')
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

/**
 * Fetch a URL and return the decoded document. Throws on invalid URLs,
 * non-html content types, timeouts, redirect loops, DNS/network failures
 * and non-2xx statuses (with the status in the message).
 */
export async function fetchPage(input: string, config: FetchConfig): Promise<FetchedPage> {
  let current = assertHttpUrl(input)

  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    let response: Response
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: {
          'user-agent': config.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      })
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
    const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml'
    const isPlain = contentType === 'text/plain'
    if (!isHtml && !isPlain) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`unsupported content type "${contentType}" at ${current} — this tool reads HTML and plain text pages only`)
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
