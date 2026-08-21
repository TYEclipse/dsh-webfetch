/**
 * Tool definitions for dsh-webfetch: two read-only web tools exposed to every
 * agent — web_fetch (URL to clean markdown/text) and web_links (link
 * inventory of a page). Both validate the URL, follow a bounded number of
 * redirects, enforce a size cap and never send credentials.
 *
 * @module dsh-webfetch/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { extractPage } from "./html.js";
import { fetchFeed, fetchPage, resolveHref } from "./fetch.js";
import { parseFeed, truncateText } from "./feed.js";
/** Fetch a page and extract its content; shared by both tools. */
async function readPage(url, config, maxChars, format, extractLinks) {
    const fetched = await fetchPage(url, config);
    const page = extractPage(fetched.body, { format, maxChars, extractLinks });
    return { fetched, page };
}
/** Compact text renderer for web_fetch results. */
function renderFetch(value) {
    const result = value;
    const header = result.title !== '' ? `title: ${result.title}` : '(no title)';
    const redirectNote = result.url !== result.finalUrl ? ` (redirected from ${result.url})` : '';
    const truncatedNote = result.truncated ? '\n[content truncated — use a smaller page or raise maxChars]' : '';
    return `HTTP ${result.status}${redirectNote} — ${header}\n${result.content}${truncatedNote}`;
}
/** Compact text renderer for web_links results. */
function renderLinks(value) {
    const result = value;
    if (result.links.length === 0)
        return `no links found on ${result.finalUrl}`;
    const lines = result.links.map((link, index) => `  ${index + 1}. ${link.text === '' ? link.href : `${link.text} — ${link.href}`}`);
    return `${result.count} link(s) on ${result.finalUrl}:\n${lines.join('\n')}`;
}
/** Compact markdown renderer for web_feed results. */
function renderFeed(value) {
    const result = value;
    const lines = [
        `feed: ${result.feedTitle}`,
        `${result.entryCount} entr${result.entryCount === 1 ? 'y' : 'ies'} from ${result.finalUrl}`,
    ];
    for (const [index, entry] of result.entries.entries()) {
        lines.push(`${index + 1}. ${entry.title}${entry.url === '' ? '' : ` — ${entry.url}`}`);
        if (entry.published !== undefined)
            lines.push(`   published: ${entry.published}`);
        if (entry.author !== undefined)
            lines.push(`   author: ${entry.author}`);
        if (entry.summary !== undefined)
            lines.push(`   ${entry.summary}`);
        if (entry.content !== undefined)
            lines.push(`   ${entry.content}`);
    }
    if (result.truncated)
        lines.push('[feed truncated — response body exceeded the size cap]');
    return lines.join('\n');
}
/** Build the two web tool definitions from the resolved config. */
export function buildWebfetchTools(config) {
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
            render: (_args, value) => [{ type: 'text', text: renderFetch(value) }],
        },
        async execute(args) {
            const maxChars = Math.min(Math.max(args.maxChars ?? config.maxChars, 1_000), 200_000);
            const { fetched, page } = await readPage(args.url, config, maxChars, args.format ?? 'markdown', args.extractLinks ?? false);
            const links = (args.extractLinks ?? false)
                ? page.links.map((link) => ({ text: link.text, href: resolveHref(link.href, fetched.finalUrl) })).filter((link) => link.href !== '')
                : [];
            return {
                url: args.url,
                finalUrl: fetched.finalUrl,
                status: fetched.status,
                title: page.title,
                content: page.content,
                length: page.content.length,
                truncated: fetched.truncated || page.truncated,
                links,
            };
        },
    });
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
            render: (_args, value) => [{ type: 'text', text: renderLinks(value) }],
        },
        async execute(args) {
            const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
            const { fetched, page } = await readPage(args.url, config, config.maxChars, 'text', true);
            const seen = new Set();
            const links = [];
            for (const link of page.links) {
                const href = resolveHref(link.href, fetched.finalUrl);
                if (href === '' || seen.has(href))
                    continue;
                seen.add(href);
                links.push({ text: link.text, href });
                if (links.length >= limit)
                    break;
            }
            return {
                url: args.url,
                finalUrl: fetched.finalUrl,
                status: fetched.status,
                count: links.length,
                links,
            };
        },
    });
    const web_feed = defineTool({
        name: 'web_feed',
        description: 'Read an RSS 2.0 or Atom syndication feed by URL and return its entries as a clean, '
            + 'LLM-friendly listing (title, link, published date, author, summary and optionally full content). '
            + 'Pairs with web_fetch: feed URLs are XML documents that web_fetch cannot extract from. Handles '
            + 'CDATA, HTML entities and relative links. Read-only, sends no credentials or cookies.',
        parameters: {
            url: { type: 'string', required: true, description: 'Full http/https URL of the RSS or Atom feed to read.' },
            maxItems: { type: 'number', description: 'Max entries to return (1–50, default 10).' },
            includeContent: { type: 'boolean', description: 'Also return each entry\'s full content (default false: summaries only).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    url: { type: 'string', required: true },
                    finalUrl: { type: 'string', required: true },
                    status: { type: 'number', required: true },
                    feedTitle: { type: 'string', required: true },
                    entryCount: { type: 'number', required: true },
                    truncated: { type: 'boolean', required: true },
                    entries: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                title: { type: 'string', required: true },
                                url: { type: 'string', required: true },
                                published: { type: 'string' },
                                author: { type: 'string' },
                                summary: { type: 'string' },
                                content: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderFeed(value) }],
        },
        async execute(args) {
            const maxItems = Math.min(Math.max(args.maxItems ?? 10, 1), 50);
            const fetched = await fetchFeed(args.url, config);
            const feed = parseFeed(fetched.body);
            const entries = feed.entries.slice(0, maxItems).map((entry) => {
                const item = { title: entry.title, url: resolveHref(entry.url, fetched.finalUrl) };
                if (entry.published !== '')
                    item.published = entry.published;
                if (entry.author !== '')
                    item.author = entry.author;
                if (entry.summary !== '')
                    item.summary = truncateText(entry.summary, 500);
                if (args.includeContent ?? false) {
                    const full = entry.content !== '' ? entry.content : entry.summary;
                    if (full !== '')
                        item.content = truncateText(full, 2_000);
                }
                return item;
            });
            return {
                url: args.url,
                finalUrl: fetched.finalUrl,
                status: fetched.status,
                feedTitle: feed.title,
                entryCount: entries.length,
                truncated: fetched.truncated,
                entries,
            };
        },
    });
    return { web_fetch, web_links, web_feed };
}
//# sourceMappingURL=tools.js.map