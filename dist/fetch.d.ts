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
    timeoutMs: number;
    /** Maximum accepted response body size in bytes (before decoding). */
    maxBytes: number;
    /** Maximum number of redirects to follow. */
    maxRedirects: number;
    /** User-Agent header value. */
    userAgent: string;
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