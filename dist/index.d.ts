/**
 * dsh-webfetch — web page reader for DeepSeek Harness.
 *
 * Three read-only tools, zero runtime dependencies (node built-ins + global
 * fetch only):
 *   web_fetch   — fetch a URL and extract clean markdown or plain text
 *                 (headings, links, lists, code fences; scripts and styling
 *                 stripped), with a size cap and a bounded redirect chain
 *   web_links   — inventory every link on a page, resolved to absolute URLs,
 *                 deduplicated and capped
 *   web_feed    — read an RSS 2.0 / Atom feed and return a clean entry
 *                 listing (title, link, date, author, summary, content)
 *
 * Safety model: http/https only, embedded URL credentials rejected, no
 * cookies or credentials sent, redirect hops limited, body size capped,
 * every request has a hard timeout, and only text/html, text/plain or
 * (for feeds) XML content types are parsed.
 *
 * @module dsh-webfetch
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type ProxyConf } from './proxy.ts';
/** Stable Cordis plugin name (also the config key under `plugins:`). */
export declare const name = "dsh-webfetch";
/** Services required before tool registration can start. */
export declare const inject: string[];
/** Plugin configuration, resolved with defaults by the loader. */
export interface Config {
    /** Per-request timeout in ms (1000–60000). */
    timeoutMs?: number;
    /** Maximum accepted response size in bytes (10000–5000000). */
    maxBytes?: number;
    /** Default extracted-content cap in characters (1000–200000). */
    maxChars?: number;
    /** Maximum redirects to follow (0–10). */
    maxRedirects?: number;
    /** User-Agent header value. */
    userAgent?: string;
    /** http proxy URL (http://host:port); empty string disables; default: HTTP_PROXY env. */
    httpProxy?: string;
    /** https proxy URL; empty string disables; default: HTTPS_PROXY env. */
    httpsProxy?: string;
    /** NO_PROXY bypass list; default: NO_PROXY env. */
    noProxy?: string;
}
export declare const Config: z<Config>;
/** Config with every default resolved (all fields guaranteed). */
export interface ResolvedConfig {
    timeoutMs: number;
    maxBytes: number;
    maxChars: number;
    maxRedirects: number;
    userAgent: string;
    proxy: ProxyConf;
}
/** Resolve loader config into the effective runtime config. */
export declare function resolveConfig(config: Config, env?: Record<string, string | undefined>): ResolvedConfig;
/** Mount the web tools on every live agent and every future one. */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map