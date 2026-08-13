/**
 * Tool definitions for dsh-webfetch: two read-only web tools exposed to every
 * agent — web_fetch (URL to clean markdown/text) and web_links (link
 * inventory of a page). Both validate the URL, follow a bounded number of
 * redirects, enforce a size cap and never send credentials.
 *
 * @module dsh-webfetch/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { extractPage, type ExtractedPage } from './html.ts'
import { fetchPage, resolveHref, type FetchedPage, type FetchConfig } from './fetch.ts'
import type { ResolvedConfig } from './index.ts'

export interface ToolSet {
  web_fetch: ToolDefinition
  web_links: ToolDefinition
}

/** Fetch a page and extract its content; shared by both tools. */
async function readPage(url: string, config: FetchConfig, maxChars: number, format: 'markdown' | 'text', extractLinks: boolean): Promise<{ fetched: FetchedPage; page: ExtractedPage }> {
  const fetched = await fetchPage(url, config)
  const page = extractPage(fetched.body, { format, maxChars, extractLinks })
  return { fetched, page }
}

/** Compact text renderer for web_fetch results. */
function renderFetch(value: unknown): string {
  const result = value as { url: string; finalUrl: string; status: number; title: string; content: string; truncated: boolean }
  const header = result.title !== '' ? `title: ${result.title}` : '(no title)'
  const redirectNote = result.url !== result.finalUrl ? ` (redirected from ${result.url})` : ''
  const truncatedNote = result.truncated ? '\n[content truncated — use a smaller page or raise maxChars]' : ''
  return `HTTP ${result.status}${redirectNote} — ${header}\n${result.content}${truncatedNote}`
}

/** Compact text renderer for web_links results. */
function renderLinks(value: unknown): string {
  const result = value as { finalUrl: string; count: number; links: Array<{ text: string; href: string }> }
  if (result.links.length === 0) return `no links found on ${result.finalUrl}`
  const lines = result.links.map((link, index) => `  ${index + 1}. ${link.text === '' ? link.href : `${link.text} — ${link.href}`}`)
  return `${result.count} link(s) on ${result.finalUrl}:\n${lines.join('\n')}`
}

/** Build the two web tool definitions from the resolved config. */
export function buildWebfetchTools(config: ResolvedConfig): ToolSet {
  const web_fetch = defineTool({
    name: 'web_fetch',
    description: 'Fetch a web page by URL and extract its readable content as clean markdown or plain text. '
      + 'Follows redirects (http/https only), strips scripts/styles/navigation, preserves headings, links, lists '
      + 'and code blocks, and caps the response size. The companion to search: use it to read the actual page '
      + 'behind a URL. Read-only, sends no credentials or cookies.',
    parameters: {
      url: { type: 'string', required: true, description: 'Full http/https URL of the page to fetch.' },
      format: { type: 'string', enum: ['markdown', 'text'], description: 'Output format: markdown keeps link targets and headings (default), text is plain prose.' },
      extractLinks: { type: 'boolean', description: 'Also return the list of links found on the page (default false).' },
      maxChars: { type: 'number', description: 'Max characters of extracted content (1000–200000, default 50000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          finalUrl: { type: 'string', required: true },
          status: { type: 'number', required: true },
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          length: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          links: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                href: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args: { url: string }, value: unknown) => [{ type: 'text', text: renderFetch(value) }],
    },
    async execute(args: { url: string; format?: 'markdown' | 'text'; extractLinks?: boolean; maxChars?: number }) {
      const maxChars = Math.min(Math.max(args.maxChars ?? config.maxChars, 1_000), 200_000)
      const { fetched, page } = await readPage(args.url, config, maxChars, args.format ?? 'markdown', args.extractLinks ?? false)
      const links = (args.extractLinks ?? false)
        ? page.links.map((link) => ({ text: link.text, href: resolveHref(link.href, fetched.finalUrl) })).filter((link) => link.href !== '')
        : undefined
      return {
        url: args.url,
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        title: page.title,
        content: page.content,
        length: page.content.length,
        truncated: fetched.truncated || page.truncated,
        links,
      }
    },
  })

  const web_links = defineTool({
    name: 'web_links',
    description: 'Collect every link on a web page with its visible label, resolved to absolute URLs, deduplicated '
      + 'and capped at a limit. Useful for crawling site structure or mapping what a page points to. Read-only.',
    parameters: {
      url: { type: 'string', required: true, description: 'Full http/https URL of the page to scan.' },
      limit: { type: 'number', description: 'Max links to return (1–200, default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          finalUrl: { type: 'string', required: true },
          status: { type: 'number', required: true },
          count: { type: 'number', required: true },
          links: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                href: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args: { url: string }, value: unknown) => [{ type: 'text', text: renderLinks(value) }],
    },
    async execute(args: { url: string; limit?: number }) {
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
      const { fetched, page } = await readPage(args.url, config, config.maxChars, 'text', true)
      const seen = new Set<string>()
      const links: Array<{ text: string; href: string }> = []
      for (const link of page.links) {
        const href = resolveHref(link.href, fetched.finalUrl)
        if (href === '' || seen.has(href)) continue
        seen.add(href)
        links.push({ text: link.text, href })
        if (links.length >= limit) break
      }
      return {
        url: args.url,
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        count: links.length,
        links,
      }
    },
  })

  return { web_fetch, web_links }
}
