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
/** Proxy-related configuration resolved from env and plugin config. */
export interface ProxyConf {
    /** http proxy URL (http://host:port); '' = connect directly. */
    httpProxy: string;
    /** https proxy URL; '' = connect directly. */
    httpsProxy: string;
    /** NO_PROXY list (comma-separated); '' = no bypass entries. */
    noProxy: string;
}
/** Resolve proxy configuration: explicit config wins, then env, '' = disabled. */
export declare function resolveProxyConf(env: Record<string, string | undefined>, overrides: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
}): ProxyConf;
/** Check whether an IPv4 address falls inside a CIDR entry (a.b.c.d/n). */
export declare function inCidr(address: string, entry: string): boolean;
/** Decide whether a hostname should bypass the proxy (NO_PROXY semantics). */
export declare function shouldBypass(hostname: string, noProxyList: string): Promise<boolean>;
/** Decide which proxy (if any) applies to a URL. */
export declare function proxyFor(url: URL, conf: ProxyConf): Promise<{
    proxy: URL | null;
}>;
/** Options for a proxied request. */
export interface ProxyRequestOptions {
    timeoutMs: number;
    maxBytes: number;
    signal: AbortSignal;
    headers: Record<string, string>;
}
interface HeadResult {
    status: number;
    statusText: string;
    headers: Map<string, string>;
}
/** Parse an HTTP response head (status line + headers). */
export declare function parseHead(head: Buffer): HeadResult;
/** Body framing of a response. */
export type Framing = {
    kind: 'length';
    n: number;
} | {
    kind: 'chunked';
} | {
    kind: 'close';
};
/** Determine body framing from response headers. */
export declare function framingOf(headers: Map<string, string>): Framing;
/** Decode a chunked-encoding body into its payload bytes (best effort). */
export declare function decodeChunked(raw: Buffer): Buffer;
/**
 * Fetch a URL through an http proxy, returning a standard Response object.
 * Supports https via CONNECT tunnelling (TLS to the target, verified against
 * the system trust store) and http via the absolute-URI request form.
 */
export declare function proxiedFetch(target: URL, proxy: URL, options: ProxyRequestOptions): Promise<Response>;
export {};
//# sourceMappingURL=proxy.d.ts.map