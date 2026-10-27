/**
 * Dependency-free sitemap.xml / sitemapindex.xml and robots.txt parser for
 * dsh-webfetch.
 *
 * Sitemaps are XML documents that list a site's own URLs (plus optional
 * lastmod/changefreq/priority metadata); a sitemap *index* points at other
 * sitemaps. robots.txt is the de-facto place where a site publishes those
 * sitemap locations (`Sitemap:` directives), so the two are read together:
 * robots.txt for discovery, the sitemaps for the URL inventory.
 *
 * The parser is intentionally small and defensive, like the feed parser: it
 * detects the document kind from the root element, extracts blocks with
 * bounded regexes, decodes entities, strips markup and truncates long values.
 * It never executes anything from the document and resolves nothing by itself
 * (URL resolution against the sitemap URL happens in the tool layer).
 *
 * @module dsh-webfetch/sitemap
 */
import { decodeEntities, stripTags } from "./feed.js";
/** Default number of URLs returned by web_sitemap. */
export const DEFAULT_MAX_URLS = 100;
/** Hard upper bound for maxUrls. */
export const MAX_URLS_LIMIT = 1_000;
/** Default number of sitemap documents fetched by web_sitemap. */
export const DEFAULT_MAX_SITEMAPS = 5;
/** Hard upper bound for maxSitemaps. */
export const MAX_SITEMAPS_LIMIT = 20;
/** Nested sitemap indexes are followed at most this deep (0 = seeds only). */
export const MAX_SITEMAP_DEPTH = 2;
/** Per-value cap for a `<loc>` (keeps a hostile document from bloating output). */
export const MAX_LOC_CHARS = 2_000;
/** Per-value cap for `<lastmod>`. */
export const MAX_LASTMOD_CHARS = 40;
/** Per-value cap for `<changefreq>`. */
export const MAX_CHANGEFREQ_CHARS = 20;
/** Collapse whitespace and cut a string to `max` characters. */
function cleanText(raw, max) {
    const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    const decoded = decodeEntities(withoutCdata);
    const text = stripTags(decoded).replace(/\s+/g, ' ').trim();
    return text.length <= max ? text : text.slice(0, max);
}
/** Text of the first `<tag>…</tag>` inside a block ('' when absent). */
function tagText(block, tag, max) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = re.exec(block);
    return match?.[1] === undefined ? '' : cleanText(match[1], max);
}
/**
 * Fold a priority to a printable number: two decimals, and `-0` folded to `0`
 * so a JSON round-trip never reports "lost information" for a plain zero.
 */
export function roundPriority(value) {
    const rounded = Math.round(value * 100) / 100;
    return rounded === 0 ? 0 : rounded;
}
/** Parse the `<priority>` of one URL entry, null when absent or unparsable. */
function parsePriority(block) {
    const raw = tagText(block, 'priority', MAX_CHANGEFREQ_CHARS);
    if (raw === '')
        return null;
    const value = Number(raw);
    if (!Number.isFinite(value))
        return null;
    return roundPriority(value);
}
/**
 * Parse a robots.txt document: the `Sitemap:` directives (used to discover
 * sitemaps) and the first `Crawl-delay:`. Comments (`#…`) and `User-agent`
 * scoping are intentionally ignored — Sitemap directives are global.
 */
export function parseRobots(text) {
    const sitemaps = [];
    const seen = new Set();
    let crawlDelay = '';
    for (const rawLine of text.split(/\r\n|\r|\n/)) {
        const line = rawLine.split('#')[0]?.trim() ?? '';
        if (line === '')
            continue;
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (key === 'sitemap' && value !== '') {
            if (!seen.has(value)) {
                seen.add(value);
                sitemaps.push(value);
            }
        }
        else if (key === 'crawl-delay' && crawlDelay === '') {
            crawlDelay = value.slice(0, MAX_CHANGEFREQ_CHARS);
        }
    }
    return { sitemaps, crawlDelay };
}
/**
 * Parse a sitemap document. Throws when the root element is neither
 * `<urlset>` nor `<sitemapindex>` — a plain web page is not a sitemap, and
 * guessing would silently produce an empty inventory.
 */
export function parseSitemap(xml) {
    if (/<sitemapindex[\s>]/i.test(xml)) {
        const sitemaps = [];
        const seen = new Set();
        for (const match of xml.matchAll(/<sitemap(?:\s[^>]*)?>([\s\S]*?)<\/sitemap>/gi)) {
            const block = match[1];
            if (block === undefined)
                continue;
            const loc = tagText(block, 'loc', MAX_LOC_CHARS);
            if (loc === '' || seen.has(loc))
                continue;
            seen.add(loc);
            sitemaps.push(loc);
        }
        return { kind: 'sitemapindex', urls: [], sitemaps };
    }
    if (/<urlset[\s>]/i.test(xml)) {
        const urls = [];
        for (const match of xml.matchAll(/<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/gi)) {
            const block = match[1];
            if (block === undefined)
                continue;
            const loc = tagText(block, 'loc', MAX_LOC_CHARS);
            if (loc === '')
                continue;
            urls.push({
                loc,
                lastmod: tagText(block, 'lastmod', MAX_LASTMOD_CHARS),
                changefreq: tagText(block, 'changefreq', MAX_CHANGEFREQ_CHARS),
                priority: parsePriority(block),
            });
        }
        return { kind: 'urlset', urls, sitemaps: [] };
    }
    throw new Error('not a recognized sitemap document (no <urlset> or <sitemapindex> root element found)');
}
/**
 * True when the URL itself looks like a sitemap (`.xml`, `.xml.gz` or a path
 * containing "sitemap") — such an input is read directly instead of going
 * through robots.txt discovery.
 */
export function isSitemapLike(input) {
    let url;
    try {
        url = new URL(input);
    }
    catch {
        return false;
    }
    const path = url.pathname.toLowerCase();
    return path.endsWith('.xml') || path.endsWith('.xml.gz') || path.includes('sitemap');
}
//# sourceMappingURL=sitemap.js.map