/**
 * Header probing layer for dsh-webfetch: inspects an URL with a HEAD (or
 * GET) request and reports the HTTP status, response headers and the
 * redirect chain without downloading the page body. Shares the URL
 * validation, timeout, redirect-bound and proxy-transport machinery with
 * fetch.ts. HEAD is tried first; when the server answers 405/501 the probe
 * transparently falls back to GET once. Read-only, sends no credentials.
 *
 * @module dsh-webfetch/head
 */

import { assertHttpUrl, type FetchConfig } from './fetch.ts'
import { proxyFor, proxiedFetch } from './proxy.ts'

/** One hop of a followed redirect chain. */
export interface RedirectHop {
  /** URL that answered with a redirect. */
  url: string
  /** HTTP status of the redirect (301/302/303/307/308). */
  status: number
  /** Absolute URL the redirect points to. */
  location: string
}

/** Result of a header probe. */
export interface HeaderProbe {
  /** The URL as requested (validated). */
  url: string
  /** The URL the final response was served from (after redirects). */
  finalUrl: string
  /** Final HTTP status (any status is reported — this is a diagnostic). */
  status: number
  statusText: string
  /** Method that produced the final status (fallback is noted). */
  method: string
  /** All response headers of the final response (lower-cased keys). */
  headers: Record<string, string>
  /** Redirect hops followed (empty when none or followRedirects=false). */
  redirects: RedirectHop[]
}

/** Status codes that mean "this server does not implement HEAD". */
const HEAD_UNSUPPORTED = new Set([405, 501])

/** Status codes treated as redirects. */
const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * Probe a URL and return its status, headers and redirect chain. Unlike
 * fetchPage this never rejects on non-2xx statuses — reporting them is the
 * point. Throws on invalid URLs, timeouts, DNS/network failures, redirects
 * without a Location header and redirect limits.
 */
export async function probeUrl(
  input: string,
  config: FetchConfig,
  method: 'HEAD' | 'GET',
  followRedirects: boolean,
): Promise<HeaderProbe> {
  const startUrl = assertHttpUrl(input)
  let current = startUrl
  let usedMethod: string = method
  const redirects: RedirectHop[] = []
  const maxHops = followRedirects ? config.maxRedirects : 0

  for (let hop = 0; hop <= maxHops; hop += 1) {
    const target = new URL(current)
    const decision = await proxyFor(target, config.proxy)
    const signal = AbortSignal.timeout(config.timeoutMs)
    const headers = { 'user-agent': config.userAgent, accept: '*/*' }
    let response: Response
    try {
      response = decision.proxy === null
        ? await fetch(target, { redirect: 'manual', signal, headers, method: usedMethod })
        : await proxiedFetch(target, decision.proxy, { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, signal, headers, method: usedMethod })
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error(`timed out after ${config.timeoutMs} ms probing ${current}`)
      }
      throw new Error(`request failed for ${current}: ${error instanceof Error ? error.message : String(error)}`)
    }

    const status = response.status

    // HEAD unsupported: retry the same URL with GET exactly once.
    if (usedMethod === 'HEAD' && HEAD_UNSUPPORTED.has(status)) {
      await response.body?.cancel().catch(() => {})
      usedMethod = 'GET'
      continue
    }

    if (followRedirects && REDIRECTS.has(status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (location === null || location === '') {
        throw new Error(`HTTP ${status} redirect from ${current} without a Location header`)
      }
      if (hop === maxHops) {
        throw new Error(`too many redirects (limit ${config.maxRedirects}) probing ${startUrl}`)
      }
      const resolved = assertHttpUrl(new URL(location, current).toString())
      redirects.push({ url: current, status, location: resolved })
      current = resolved
      continue
    }

    await response.body?.cancel().catch(() => {})
    return {
      url: startUrl,
      finalUrl: current,
      status,
      statusText: response.statusText,
      method: usedMethod === 'GET' && method === 'HEAD' ? 'GET (HEAD not supported)' : usedMethod,
      headers: Object.fromEntries(response.headers),
      redirects,
    }
  }

  // Unreachable: the loop above always returns or throws.
  throw new Error(`unreachable redirect loop for ${startUrl}`)
}
