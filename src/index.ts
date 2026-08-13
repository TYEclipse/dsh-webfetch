/**
 * dsh-webfetch — web page reader for DeepSeek Harness.
 *
 * Two read-only tools, zero runtime dependencies (node built-ins + global
 * fetch only):
 *   web_fetch   — fetch a URL and extract clean markdown or plain text
 *                 (headings, links, lists, code fences; scripts and styling
 *                 stripped), with a size cap and a bounded redirect chain
 *   web_links   — inventory every link on a page, resolved to absolute URLs,
 *                 deduplicated and capped
 *
 * Safety model: http/https only, embedded URL credentials rejected, no
 * cookies or credentials sent, redirect hops limited, body size capped,
 * every request has a hard timeout, and only text/html or text/plain
 * responses are parsed.
 *
 * @module dsh-webfetch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { buildWebfetchTools, type ToolSet } from './tools.ts'

/** Stable Cordis plugin name (also the config key under `plugins:`). */
export const name = 'dsh-webfetch'

/** Services required before tool registration can start. */
export const inject = ['agents', 'tools']

/** Plugin configuration, resolved with defaults by the loader. */
export interface Config {
  /** Per-request timeout in ms (1000–60000). */
  timeoutMs?: number
  /** Maximum accepted response size in bytes (10000–5000000). */
  maxBytes?: number
  /** Default extracted-content cap in characters (1000–200000). */
  maxChars?: number
  /** Maximum redirects to follow (0–10). */
  maxRedirects?: number
  /** User-Agent header value. */
  userAgent?: string
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().min(1_000).max(60_000).default(10_000),
  maxBytes: z.number().min(10_000).max(5_000_000).default(1_500_000),
  maxChars: z.number().min(1_000).max(200_000).default(50_000),
  maxRedirects: z.number().step(1).min(0).max(10).default(3),
  userAgent: z.string().max(200).default('dsh-webfetch/0.1 (DeepSeek Harness plugin)'),
})

/** Config with every default resolved (all fields guaranteed). */
export interface ResolvedConfig {
  timeoutMs: number
  maxBytes: number
  maxChars: number
  maxRedirects: number
  userAgent: string
}

/** Resolve loader config into the effective runtime config. */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    timeoutMs: config.timeoutMs ?? 10_000,
    maxBytes: config.maxBytes ?? 1_500_000,
    maxChars: config.maxChars ?? 50_000,
    maxRedirects: config.maxRedirects ?? 3,
    userAgent: config.userAgent ?? 'dsh-webfetch/0.1 (DeepSeek Harness plugin)',
  }
}

/** Register both web tools on one agent; returns the disposer. */
function decorate(agent: Agent, tools: ToolSet): () => void {
  const disposers = Object.values(tools).map((definition) => agent.ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // already disposed
      }
    }
  }
}

/** Mount the web tools on every live agent and every future one. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const tools = buildWebfetchTools(resolved)
  const disposers = new Set<() => void>()

  const decorateAgent = (agent: Agent): void => {
    try {
      disposers.add(decorate(agent, tools))
    } catch (error) {
      ctx.logger('webfetch').warn(`tool registration for agent ${agent.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const agent of ctx.agents.list()) decorateAgent(agent)
  const off = ctx.on('agent/created', ({ agent }) => decorateAgent(agent))

  ctx.effect(() => () => {
    off()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // already disposed
      }
    }
    disposers.clear()
  })
}
