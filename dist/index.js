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
import z from '@deepseek-ai/schemastery';
import { resolveProxyConf } from "./proxy.js";
import { buildWebfetchTools } from "./tools.js";
/** Stable Cordis plugin name (also the config key under `plugins:`). */
export const name = 'dsh-webfetch';
/** Services required before tool registration can start. */
export const inject = ['agents', 'tools'];
export const Config = z.object({
    timeoutMs: z.number().min(1_000).max(60_000).default(10_000),
    maxBytes: z.number().min(10_000).max(5_000_000).default(1_500_000),
    maxChars: z.number().min(1_000).max(200_000).default(50_000),
    maxRedirects: z.number().step(1).min(0).max(10).default(3),
    userAgent: z.string().max(200).default('dsh-webfetch/0.2 (DeepSeek Harness plugin)'),
    httpProxy: z.string().max(500),
    httpsProxy: z.string().max(500),
    noProxy: z.string().max(2000),
});
/** Resolve loader config into the effective runtime config. */
export function resolveConfig(config, env = process.env) {
    return {
        timeoutMs: config.timeoutMs ?? 10_000,
        maxBytes: config.maxBytes ?? 1_500_000,
        maxChars: config.maxChars ?? 50_000,
        maxRedirects: config.maxRedirects ?? 3,
        userAgent: config.userAgent ?? 'dsh-webfetch/0.2 (DeepSeek Harness plugin)',
        proxy: resolveProxyConf(env, { httpProxy: config.httpProxy, httpsProxy: config.httpsProxy, noProxy: config.noProxy }),
    };
}
/** Register both web tools on one agent; returns the disposer. */
function decorate(agent, tools) {
    const disposers = Object.values(tools).map((definition) => agent.ctx.tools.register(definition));
    return () => {
        for (const dispose of disposers) {
            try {
                dispose();
            }
            catch {
                // already disposed
            }
        }
    };
}
/** Mount the web tools on every live agent and every future one. */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const tools = buildWebfetchTools(resolved);
    const disposers = new Set();
    const decorateAgent = (agent) => {
        try {
            disposers.add(decorate(agent, tools));
        }
        catch (error) {
            ctx.logger('webfetch').warn(`tool registration for agent ${agent.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    for (const agent of ctx.agents.list())
        decorateAgent(agent);
    const off = ctx.on('agent/created', ({ agent }) => decorateAgent(agent));
    ctx.effect(() => () => {
        off();
        for (const dispose of disposers) {
            try {
                dispose();
            }
            catch {
                // already disposed
            }
        }
        disposers.clear();
    });
}
//# sourceMappingURL=index.js.map