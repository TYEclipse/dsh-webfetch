/**
 * Tool definitions for dsh-webfetch: read-only web tools exposed to every
 * agent — web_fetch (URL to clean markdown/text), web_links (link
 * inventory of a page), web_feed (RSS/Atom entry listing), web_headers
 * (HTTP status/headers/redirect chain without the body), web_table
 * (HTML tables as structured rows) and web_meta (the page's own metadata:
 * title, description, canonical, hreflang alternates, Open Graph, Twitter
 * cards, feed autodiscovery, icons and JSON-LD). All validate the
 * URL, follow a bounded number of redirects, enforce a size cap and never
 * send credentials.
 *
 * @module dsh-webfetch/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { extractPage } from "./html.js";
import { extractTables } from "./table.js";
import { extractMeta, MAX_JSON_LD_BLOCKS } from "./meta.js";
import { fetchFeed, fetchPage, resolveHref } from "./fetch.js";
import { parseFeed, truncateText } from "./feed.js";
import { probeUrl } from "./head.js";
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
/** Compact text renderer for web_feed results. */
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
/** Compact text renderer for web_headers results. */
function renderHeaders(value) {
    const result = value;
    const lines = [`HTTP ${result.status} ${result.statusText} — ${result.method} ${result.url}`];
    if (result.url !== result.finalUrl)
        lines.push(`final URL: ${result.finalUrl}`);
    if (result.redirects.length > 0) {
        lines.push('redirect chain:');
        for (const [index, hop] of result.redirects.entries()) {
            lines.push(`  ${index + 1}. ${hop.status} ${hop.url} → ${hop.location}`);
        }
    }
    const entries = Object.entries(result.headers);
    lines.push(`${entries.length} header(s):`);
    for (const [key, value] of entries)
        lines.push(`  ${key}: ${value}`);
    return lines.join('\n');
}
/** Compact text renderer for web_table results. */
function renderTable(value) {
    const result = value;
    if (result.tableCount === 0)
        return `no tables found on ${result.finalUrl}`;
    const head = result.tableCount < result.totalTables
        ? `${result.tableCount} of ${result.totalTables} table(s) on ${result.finalUrl}`
        : `${result.tableCount} table(s) on ${result.finalUrl}`;
    const lines = [head];
    for (const table of result.tables) {
        lines.push(`table ${table.index}${table.caption === '' ? '' : ` — ${table.caption}`} (${table.cols} column${table.cols === 1 ? '' : 's'})`);
        if (table.header.length > 0)
            lines.push(`  [header] ${table.header.join(' | ')}`);
        for (const row of table.rows)
            lines.push(`  ${row.join(' | ')}`);
    }
    if (result.truncated)
        lines.push('[output capped — raise maxRows/maxTables or target one table with the `table` argument]');
    return lines.join('\n');
}
/** Compact text renderer for web_meta results. */
function renderMeta(value) {
    const result = value;
    const redirectNote = result.url !== result.finalUrl ? ` (redirected from ${result.url})` : '';
    const lines = [`HTTP ${result.status}${redirectNote} — metadata of ${result.finalUrl}`];
    const field = (label, text) => {
        if (text !== '')
            lines.push(`${label}: ${text}`);
    };
    field('title', result.title);
    field('description', result.description);
    field('canonical', result.canonical);
    if (result.lang !== '' || result.charset !== '') {
        lines.push(`lang: ${result.lang === '' ? '(unset)' : result.lang} — charset: ${result.charset === '' ? '(unset)' : result.charset}`);
    }
    field('robots', result.robots);
    field('author', result.author);
    const group = (label, entries) => {
        if (entries.length === 0)
            return;
        lines.push(`${label} (${entries.length}):`);
        for (const entry of entries)
            lines.push(`  ${entry.name} — ${entry.content}`);
    };
    group('open graph', result.openGraph);
    group('twitter', result.twitter);
    if (result.alternates.length > 0) {
        lines.push(`hreflang alternates (${result.alternates.length}):`);
        for (const alternate of result.alternates)
            lines.push(`  ${alternate.hreflang} — ${alternate.href}`);
    }
    if (result.feeds.length > 0) {
        lines.push(`feeds (${result.feeds.length}):`);
        for (const feed of result.feeds) {
            lines.push(`  ${feed.type}${feed.title === '' ? '' : ` — ${feed.title}`} — ${feed.href}`);
        }
    }
    if (result.icons.length > 0) {
        lines.push(`icons (${result.icons.length}):`);
        for (const icon of result.icons)
            lines.push(`  ${icon}`);
    }
    const invalid = result.jsonLdInvalid > 0 ? ` (${result.jsonLdInvalid} invalid)` : '';
    lines.push(`json-ld: ${result.jsonLdCount} block(s)${invalid}`);
    for (const block of result.jsonLd) {
        lines.push(block.valid
            ? `  ${block.index}. ${block.types.length === 0 ? '(no @type)' : block.types.join(', ')}`
            : `  ${block.index}. invalid — ${block.error ?? 'unknown error'}`);
    }
    return lines.join('\n');
}
/** Build the web tool definitions from the resolved config. */
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
    const web_headers = defineTool({
        name: 'web_headers',
        description: 'Inspect the HTTP status, response headers and redirect chain of a URL without downloading '
            + 'the page body. Uses HEAD by default (falls back to GET automatically when the server does not support '
            + 'HEAD); any status is reported — this is a diagnostic, unlike web_fetch. Useful before fetching to '
            + 'check status codes, content types, redirects, caching or security headers of an endpoint. '
            + 'Read-only, sends no credentials or cookies.',
        parameters: {
            url: { type: 'string', required: true, description: 'Full http/https URL to inspect.' },
            method: { type: 'string', enum: ['HEAD', 'GET'], description: 'HTTP method: HEAD downloads no body (default, falls back to GET automatically when unsupported); GET always works but transfers the body.' },
            followRedirects: { type: 'boolean', description: 'Follow redirects and report the chain (default true).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    url: { type: 'string', required: true },
                    finalUrl: { type: 'string', required: true },
                    status: { type: 'number', required: true },
                    statusText: { type: 'string', required: true },
                    method: { type: 'string', required: true },
                    headers: {
                        type: 'object',
                        additionalProperties: true,
                        required: true,
                    },
                    redirects: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                url: { type: 'string', required: true },
                                status: { type: 'number', required: true },
                                location: { type: 'string', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderHeaders(value) }],
        },
        async execute(args) {
            const method = args.method === 'GET' ? 'GET' : 'HEAD';
            const result = await probeUrl(args.url, config, method, args.followRedirects ?? true);
            return {
                url: result.url,
                finalUrl: result.finalUrl,
                status: result.status,
                statusText: result.statusText,
                method: result.method,
                headers: result.headers,
                redirects: result.redirects.map((hop) => ({ url: hop.url, status: hop.status, location: hop.location })),
            };
        },
    });
    const web_table = defineTool({
        name: 'web_table',
        description: 'Extract the HTML tables of a web page as structured rows (arrays of cell strings) — the tables '
            + 'counterpart of web_fetch, for spec sheets, pricing pages and comparison charts. Returns up to maxTables '
            + 'tables, or one table by its 1-based position, each with up to maxRows data rows. The first row is '
            + 'reported as the header when the page marks it (<thead> or all-<th> cells); colspan/rowspan are expanded '
            + 'into a rectangular grid with the spanning text repeated in every covered slot; nested tables are '
            + 'flattened into the containing cell. Read-only, sends no credentials or cookies.',
        parameters: {
            url: { type: 'string', required: true, description: 'Full http/https URL of the page to scan for tables.' },
            table: { type: 'number', description: 'Return only the table at this 1-based position (default: list up to maxTables).' },
            maxTables: { type: 'number', description: 'Max tables to return (1–20, default 5).' },
            maxRows: { type: 'number', description: 'Max data rows per table (1–200, default 50).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    url: { type: 'string', required: true },
                    finalUrl: { type: 'string', required: true },
                    status: { type: 'number', required: true },
                    tableCount: { type: 'number', required: true },
                    totalTables: { type: 'number', required: true },
                    truncated: { type: 'boolean', required: true },
                    tables: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                index: { type: 'number', required: true },
                                caption: { type: 'string', required: true },
                                cols: { type: 'number', required: true },
                                header: { type: 'array', required: true, items: { type: 'string' } },
                                rows: { type: 'array', required: true, items: { type: 'array', items: { type: 'string' } } },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderTable(value) }],
        },
        async execute(args) {
            const maxRows = Math.min(Math.max(args.maxRows ?? 50, 1), 200);
            const maxTables = Math.min(Math.max(args.maxTables ?? 5, 1), 20);
            if (args.table !== undefined && (!Number.isInteger(args.table) || args.table < 1)) {
                throw new Error(`table must be a positive integer (1-based table position); got ${args.table}`);
            }
            const scanCap = args.table !== undefined ? Math.min(args.table, 50) : maxTables;
            const fetched = await fetchPage(args.url, config);
            const extracted = extractTables(fetched.body, { maxTables: scanCap, maxRows });
            let tables = extracted.tables;
            if (args.table !== undefined) {
                const picked = tables.find((candidate) => candidate.index === args.table);
                if (picked === undefined) {
                    throw new Error(`table #${args.table} not found — the page has ${extracted.totalTables} table(s)`);
                }
                tables = [picked];
            }
            return {
                url: args.url,
                finalUrl: fetched.finalUrl,
                status: fetched.status,
                tableCount: tables.length,
                totalTables: extracted.totalTables,
                truncated: fetched.truncated || (args.table === undefined ? extracted.truncated : extracted.rowsCapped),
                tables,
            };
        },
    });
    const web_meta = defineTool({
        name: 'web_meta',
        description: 'Read what a web page says about itself: title, description, canonical URL, language, charset, '
            + 'robots policy, author, Open Graph and article properties, Twitter card tags, hreflang alternates, feed '
            + 'autodiscovery links, icons and JSON-LD blocks (with their @type names). The metadata counterpart of '
            + 'web_fetch: use it to identify, classify or deduplicate a page, or to discover its feed and language '
            + 'variants without reading the whole body. Values are reported as written (entity-decoded, '
            + 'whitespace-normalized, 1000-char cap); canonical/alternate/feed/icon URLs are resolved to absolute. '
            + 'A JSON-LD block that does not parse is reported as invalid with the parser message instead of being '
            + 'dropped. Read-only, sends no credentials or cookies.',
        parameters: {
            url: { type: 'string', required: true, description: 'Full http/https URL of the page to inspect.' },
            maxJsonLd: { type: 'number', description: 'Max JSON-LD blocks to return (1–20, default 10).' },
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
                    description: { type: 'string', required: true },
                    canonical: { type: 'string', required: true },
                    lang: { type: 'string', required: true },
                    charset: { type: 'string', required: true },
                    robots: { type: 'string', required: true },
                    author: { type: 'string', required: true },
                    openGraph: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                name: { type: 'string', required: true },
                                content: { type: 'string', required: true },
                            },
                        },
                    },
                    twitter: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                name: { type: 'string', required: true },
                                content: { type: 'string', required: true },
                            },
                        },
                    },
                    alternates: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                hreflang: { type: 'string', required: true },
                                href: { type: 'string', required: true },
                            },
                        },
                    },
                    feeds: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                type: { type: 'string', required: true },
                                title: { type: 'string', required: true },
                                href: { type: 'string', required: true },
                            },
                        },
                    },
                    icons: { type: 'array', required: true, items: { type: 'string' } },
                    jsonLd: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                index: { type: 'number', required: true },
                                valid: { type: 'boolean', required: true },
                                types: { type: 'array', required: true, items: { type: 'string' } },
                                error: { type: 'string' },
                            },
                        },
                    },
                    jsonLdCount: { type: 'number', required: true },
                    jsonLdInvalid: { type: 'number', required: true },
                    truncated: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderMeta(value) }],
        },
        async execute(args) {
            const maxJsonLd = Math.min(Math.max(args.maxJsonLd ?? MAX_JSON_LD_BLOCKS, 1), 20);
            const fetched = await fetchPage(args.url, config);
            const meta = extractMeta(fetched.body, { maxJsonLd });
            return {
                url: args.url,
                finalUrl: fetched.finalUrl,
                status: fetched.status,
                title: meta.title,
                description: meta.description,
                canonical: resolveHref(meta.canonical, fetched.finalUrl),
                lang: meta.lang,
                charset: meta.charset,
                robots: meta.robots,
                author: meta.author,
                openGraph: meta.openGraph,
                twitter: meta.twitter,
                alternates: meta.alternates.map((alternate) => ({ hreflang: alternate.hreflang, href: resolveHref(alternate.href, fetched.finalUrl) })),
                feeds: meta.feeds.map((feed) => ({ type: feed.type, title: feed.title, href: resolveHref(feed.href, fetched.finalUrl) })),
                icons: meta.icons.map((icon) => resolveHref(icon, fetched.finalUrl)).filter((icon) => icon !== ''),
                jsonLd: meta.jsonLd,
                jsonLdCount: meta.jsonLdCount,
                jsonLdInvalid: meta.jsonLdInvalid,
                truncated: fetched.truncated || meta.truncated,
            };
        },
    });
    return { web_fetch, web_links, web_feed, web_headers, web_table, web_meta };
}
//# sourceMappingURL=tools.js.map