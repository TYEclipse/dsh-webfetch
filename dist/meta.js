/**
 * Document metadata extraction for dsh-webfetch: a dependency-free reader for
 * everything a page says about itself in its `<head>` — title, description,
 * canonical URL, language, charset, robots policy, Open Graph and Twitter
 * card tags, hreflang alternates, feed autodiscovery links, icons and
 * JSON-LD blocks.
 *
 * Documented semantics:
 * - only the `<head>` region is scanned when the document has one (text after
 *   the closing `</head>` is ignored); a document without `</head>` is scanned
 *   up to MAX_HEAD_SCAN characters and `truncated` is reported
 * - values are entity-decoded, whitespace-normalized and capped at
 *   MAX_META_TEXT characters with an ellipsis
 * - Open Graph (`og:*`) and article (`article:*`) properties and Twitter card
 *   (`twitter:*`) tags are returned as ordered `{name, content}` pairs, so
 *   repeated properties (several `og:image`) survive; exact duplicates are
 *   dropped
 * - `<title>` and `description`/`robots`/`author` come from the first matching
 *   tag; `canonical` from the first `rel="canonical"` link
 * - hreflang alternates, feed autodiscovery links (RSS/Atom/JSON Feed) and
 *   icons keep document order, deduplicated by href, capped at MAX_META_REFS
 * - JSON-LD: every non-empty `<script type="application/ld+json">` is parsed;
 *   a block that fails to parse is reported as `valid: false` with the parser
 *   message and counted in `jsonLdInvalid` — never silently dropped
 * - hrefs are returned exactly as written on the page; callers resolve them
 *   against the final URL
 *
 * @module dsh-webfetch/meta
 */
import { decodeEntities } from "./html.js";
/** Max characters of the document scanned when it has no closing `</head>`. */
export const MAX_HEAD_SCAN = 200_000;
/** Max characters kept per metadata text value (longer values get an ellipsis). */
export const MAX_META_TEXT = 1_000;
/** Max link references (alternates, feeds, icons) kept of each kind. */
export const MAX_META_REFS = 32;
/** Max JSON-LD blocks parsed and reported. */
export const MAX_JSON_LD_BLOCKS = 10;
/** Max characters of a single JSON-LD block accepted for parsing. */
export const MAX_JSON_LD_CHARS = 100_000;
/** Max `@type` names kept per JSON-LD block. */
export const MAX_JSON_LD_TYPES = 8;
/** Feed link MIME types recognised by autodiscovery. */
const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml', 'application/feed+json']);
/** Icon rel values recognised by autodiscovery. */
const ICON_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon']);
/** Decode entities, collapse whitespace and cap the value length. */
function normalizeMeta(input) {
    const clean = decodeEntities(input).replace(/\s+/g, ' ').trim();
    return clean.length > MAX_META_TEXT ? `${clean.slice(0, MAX_META_TEXT)}…` : clean;
}
/** Parse an attribute list into a lowercase-keyed lookup map. */
function parseAttributes(raw) {
    const attrs = new Map();
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const match of raw.matchAll(attrRe)) {
        const name = match[1];
        if (name === undefined)
            continue;
        attrs.set(name.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    }
    return attrs;
}
/** Append a value when its dedup key has not been seen yet (cap respected). */
function pushUnique(list, seen, key, value, cap) {
    if (seen.has(key) || list.length >= cap)
        return;
    seen.add(key);
    list.push(value);
}
/** Collect `@type` names from a parsed JSON-LD value (top level and `@graph`). */
function collectTypes(value, out) {
    if (Array.isArray(value)) {
        for (const item of value)
            collectTypes(item, out);
        return;
    }
    if (value === null || typeof value !== 'object')
        return;
    const record = value;
    const type = record['@type'];
    if (typeof type === 'string')
        out.add(type);
    else if (Array.isArray(type)) {
        for (const entry of type)
            if (typeof entry === 'string')
                out.add(entry);
    }
    const graph = record['@graph'];
    if (graph !== undefined)
        collectTypes(graph, out);
}
/** Split the head region out of a document (whole document when unclosed). */
function headRegion(html) {
    const end = /<\/head\s*>/i.exec(html);
    if (end !== null)
        return { region: html.slice(0, end.index + end[0].length), truncated: false };
    if (html.length <= MAX_HEAD_SCAN)
        return { region: html, truncated: false };
    return { region: html.slice(0, MAX_HEAD_SCAN), truncated: true };
}
/** Extract a document's `<head>` metadata. */
export function extractMeta(html, options) {
    const { region, truncated } = headRegion(html);
    const result = {
        title: '',
        description: '',
        canonical: '',
        lang: '',
        charset: '',
        robots: '',
        author: '',
        openGraph: [],
        twitter: [],
        alternates: [],
        feeds: [],
        icons: [],
        jsonLd: [],
        jsonLdCount: 0,
        jsonLdInvalid: 0,
        truncated,
    };
    const metaSeen = new Set();
    const alternateSeen = new Set();
    const feedSeen = new Set();
    const iconSeen = new Set();
    let inTitle = false;
    let titleBuf = '';
    // One pass: comments, complete <script> elements (content captured for
    // JSON-LD), every other tag, and the text between tags.
    const tokenRe = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<[^>]*>|[^<]+/gi;
    for (const token of region.matchAll(tokenRe)) {
        const chunk = token[0];
        if (chunk.startsWith('<!--'))
            continue;
        if (/^<script\b/i.test(chunk)) {
            const openEnd = chunk.indexOf('>');
            const attrs = parseAttributes(chunk.slice(1, openEnd === -1 ? chunk.length : openEnd));
            if (!(attrs.get('type') ?? '').toLowerCase().includes('ld+json'))
                continue;
            const closeStart = chunk.toLowerCase().lastIndexOf('</script');
            const raw = chunk.slice(openEnd + 1, closeStart === -1 ? chunk.length : closeStart).trim();
            if (raw === '')
                continue;
            result.jsonLdCount += 1;
            const index = result.jsonLdCount;
            if (raw.length > MAX_JSON_LD_CHARS) {
                result.jsonLdInvalid += 1;
                if (result.jsonLd.length < options.maxJsonLd) {
                    result.jsonLd.push({ index, valid: false, types: [], error: `block too large (${raw.length} chars > ${MAX_JSON_LD_CHARS})` });
                }
                continue;
            }
            let parsed;
            let valid = true;
            let error = '';
            try {
                parsed = JSON.parse(raw);
            }
            catch (cause) {
                valid = false;
                error = cause instanceof Error ? cause.message : String(cause);
            }
            if (!valid)
                result.jsonLdInvalid += 1;
            if (result.jsonLd.length >= options.maxJsonLd)
                continue;
            const types = new Set();
            if (valid)
                collectTypes(parsed, types);
            const block = { index, valid, types: [...types].slice(0, MAX_JSON_LD_TYPES) };
            if (!valid)
                block.error = normalizeMeta(error);
            result.jsonLd.push(block);
            continue;
        }
        if (chunk.startsWith('<')) {
            const closing = chunk.startsWith('</');
            const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(chunk);
            if (tagMatch?.[1] === undefined || closing) {
                if (closing && tagMatch?.[1]?.toLowerCase() === 'title' && inTitle) {
                    result.title = normalizeMeta(titleBuf);
                    titleBuf = '';
                    inTitle = false;
                }
                continue;
            }
            const tagName = tagMatch[1].toLowerCase();
            const attrs = parseAttributes(chunk.slice(1));
            if (tagName === 'title') {
                inTitle = true;
                titleBuf = '';
                continue;
            }
            if (inTitle)
                continue;
            if (tagName === 'html') {
                if (result.lang === '')
                    result.lang = normalizeMeta(attrs.get('lang') ?? '');
                continue;
            }
            if (tagName === 'meta') {
                const inlineCharset = attrs.get('charset');
                if (inlineCharset !== undefined && result.charset === '')
                    result.charset = normalizeMeta(inlineCharset);
                const httpEquiv = (attrs.get('http-equiv') ?? '').toLowerCase();
                const content = attrs.get('content') ?? '';
                if (httpEquiv === 'content-type' && result.charset === '') {
                    const charset = /charset\s*=\s*([^;\s]+)/i.exec(content);
                    if (charset?.[1] !== undefined)
                        result.charset = normalizeMeta(charset[1]);
                }
                const name = (attrs.get('name') ?? attrs.get('property') ?? attrs.get('itemprop') ?? '').toLowerCase();
                if (name === '')
                    continue;
                if (name === 'description') {
                    if (result.description === '')
                        result.description = normalizeMeta(content);
                    continue;
                }
                if (name === 'robots') {
                    if (result.robots === '')
                        result.robots = normalizeMeta(content);
                    continue;
                }
                if (name === 'author') {
                    if (result.author === '')
                        result.author = normalizeMeta(content);
                    continue;
                }
                const value = normalizeMeta(content);
                if (name.startsWith('og:') || name.startsWith('article:')) {
                    pushUnique(result.openGraph, metaSeen, `${name}\u0000${value}`, { name, content: value }, MAX_META_REFS);
                    continue;
                }
                if (name.startsWith('twitter:')) {
                    pushUnique(result.twitter, metaSeen, `${name}\u0000${value}`, { name, content: value }, MAX_META_REFS);
                }
                continue;
            }
            if (tagName === 'link') {
                const rel = (attrs.get('rel') ?? '').toLowerCase().split(/[\s,]+/).filter((part) => part !== '');
                const href = normalizeMeta(attrs.get('href') ?? '');
                if (href === '' || rel.length === 0)
                    continue;
                if (rel.includes('canonical')) {
                    if (result.canonical === '')
                        result.canonical = href;
                    continue;
                }
                const type = (attrs.get('type') ?? '').toLowerCase();
                if (rel.includes('alternate') && type !== '' && FEED_TYPES.has(type)) {
                    pushUnique(result.feeds, feedSeen, href, { type, title: normalizeMeta(attrs.get('title') ?? ''), href }, MAX_META_REFS);
                    continue;
                }
                if (rel.includes('alternate')) {
                    const hreflang = normalizeMeta(attrs.get('hreflang') ?? '');
                    if (hreflang !== '')
                        pushUnique(result.alternates, alternateSeen, `${hreflang}\u0000${href}`, { hreflang, href }, MAX_META_REFS);
                    continue;
                }
                if (rel.some((part) => ICON_RELS.has(part))) {
                    pushUnique(result.icons, iconSeen, href, href, MAX_META_REFS);
                }
                continue;
            }
            continue;
        }
        // Text node (inside <title> we keep it, elsewhere it is head whitespace).
        if (inTitle)
            titleBuf += chunk;
    }
    if (inTitle)
        result.title = normalizeMeta(titleBuf);
    return result;
}
//# sourceMappingURL=meta.js.map