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
import { type FetchConfig } from './fetch.ts';
/** One hop of a followed redirect chain. */
export interface RedirectHop {
    /** URL that answered with a redirect. */
    url: string;
    /** HTTP status of the redirect (301/302/303/307/308). */
    status: number;
    /** Absolute URL the redirect points to. */
    location: string;
}
/** Result of a header probe. */
export interface HeaderProbe {
    /** The URL as requested (validated). */
    url: string;
    /** The URL the final response was served from (after redirects). */
    finalUrl: string;
    /** Final HTTP status (any status is reported — this is a diagnostic). */
    status: number;
    statusText: string;
    /** Method that produced the final status (fallback is noted). */
    method: string;
    /** All response headers of the final response (lower-cased keys). */
    headers: Record<string, string>;
    /** Redirect hops followed (empty when none or followRedirects=false). */
    redirects: RedirectHop[];
}
/**
 * Probe a URL and return its status, headers and redirect chain. Unlike
 * fetchPage this never rejects on non-2xx statuses — reporting them is the
 * point. Throws on invalid URLs, timeouts, DNS/network failures, redirects
 * without a Location header and redirect limits.
 */
export declare function probeUrl(input: string, config: FetchConfig, method: 'HEAD' | 'GET', followRedirects: boolean): Promise<HeaderProbe>;
//# sourceMappingURL=head.d.ts.map