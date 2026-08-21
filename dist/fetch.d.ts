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
import { type ProxyConf } from './proxy.ts';
/** Runtime configuration used by the HTTP layer. */
export interface FetchConfig {
    /** Per-request timeout in ms. */
    timeoutMs: number;
    /** Maximum accepted response body size in bytes (before decoding). */
    maxBytes: number;
    /** Maximum number of redirects to follow. */
    maxRedirects: number;
    /** User-Agent header value. */
    userAgent: string;
    /** Proxy selection configuration ('' = connect directly). */
    proxy: ProxyConf;
}
/** A validated http/https URL string. */
export declare function assertHttpUrl(input: string): string;
/** Result of a fetch: raw document plus metadata. */
export interface FetchedPage {
    /** The URL the final response was served from (after redirects). */
    finalUrl: string;
    status: number;
    contentType: string;
    /** Decoded document text (HTML or plain text). */
    body: string;
    /** True when the body exceeded maxBytes and was cut off. */
    truncated: boolean;
}
/** Fetch a web page (HTML or plain text only). */
export declare function fetchPage(input: string, config: FetchConfig): Promise<FetchedPage>;
/** Fetch a syndication feed document (RSS/Atom/XML; HTML pages allowed too). */
export declare function fetchFeed(input: string, config: FetchConfig): Promise<FetchedPage>;
/** Resolve a possibly-relative href against a base page URL. */
export declare function resolveHref(href: string, baseUrl: string): string;
//# sourceMappingURL=fetch.d.ts.map