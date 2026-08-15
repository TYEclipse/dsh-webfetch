/**
 * HTML-to-text extraction for dsh-webfetch: a dependency-free tokenizer that
 * walks tags and text nodes and produces either clean plain text or a light
 * markdown rendering (headings, links, lists, code fences).
 *
 * The parser is intentionally small and defensive: it never interprets the
 * page (no scripts, no CSS, no iframes), only the document text.
 *
 * @module dsh-webfetch/html
 */
/** Elements whose entire content is dropped (metadata, styling, embedded programs). */
const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'math', 'head', 'title',
    'select', 'textarea', 'iframe', 'object', 'canvas', 'audio', 'video',
]);
/** Tags that force line breaks around their content. */
const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details',
    'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer',
    'form', 'header', 'hgroup', 'main', 'nav', 'ol', 'p', 'pre', 'section',
    'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
/** Headings by level: '#' * level in markdown mode. */
const HEADING_TAGS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
/** Void elements that can never contain text (avoids stacking bugs). */
const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr',
]);
/** Minimal named-entity table for the characters that actually appear in real pages. */
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7',
    copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0',
    laquo: '\u00ab', raquo: '\u00bb', bull: '\u2022', sect: '\u00a7', para: '\u00b6',
    ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
    times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', shy: '',
    euro: '\u20ac', pound: '\u00a3', cent: '\u00a2', curren: '\u00a4', yen: '\u00a5',
    agrave: '\u00e0', aacute: '\u00e1', acirc: '\u00e2', auml: '\u00e4', aring: '\u00e5', aelig: '\u00e6',
    egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea', euml: '\u00eb',
    igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef',
    ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4', ouml: '\u00f6', oslash: '\u00f8',
    ugrave: '\u00f9', uacute: '\u00fa', ucirc: '\u00fb', uuml: '\u00fc',
    ccedil: '\u00e7', ntilde: '\u00f1', szlig: '\u00df',
};
/** Decode HTML entities (named table above plus numeric &#123; / &#x1F600;). */
export function decodeEntities(input) {
    if (!input.includes('&'))
        return input;
    return input.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,7});/g, (entity, body) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
            const code = Number.parseInt(body.slice(2), 16);
            return Number.isNaN(code) || code > 0x10ffff ? entity : String.fromCodePoint(code);
        }
        if (body.startsWith('#')) {
            const code = Number.parseInt(body.slice(1), 10);
            return Number.isNaN(code) || code > 0x10ffff ? entity : String.fromCodePoint(code);
        }
        return NAMED_ENTITIES[body] ?? entity;
    });
}
/** Parse the attribute list of an opening tag into a lookup map. */
function parseAttributes(raw) {
    const attrs = new Map();
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const match of raw.matchAll(attrRe)) {
        const attrName = match[1];
        if (attrName === undefined)
            continue;
        attrs.set(attrName.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    }
    return attrs;
}
/** Collapse runs of whitespace; keep at most two consecutive newlines. */
function normalizeWhitespace(input) {
    return input
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/**
 * Extract readable content from an HTML document.
 * Comments, scripts, styles and embedded content are dropped; block structure
 * is preserved as newlines (plus markdown syntax in markdown mode).
 */
export function extractPage(html, options) {
    const markdown = options.format === 'markdown';
    const links = [];
    let title = '';
    let out = '';
    // Number of open skip-tag elements; when > 0 every token is ignored.
    let skipDepth = 0;
    let preDepth = 0;
    // Inside <title> we only collect the title text, not body content.
    let inTitle = false;
    let titleBuf = '';
    // Currently open <a> element (for markdown link rendering).
    let anchor;
    let anchorBuf = '';
    // Pending list-item marker (- / 1. / *) for the next text chunk.
    let listMarker = '';
    // True when the previous emitted chunk ended with an inline break, so the
    // next block tag does not insert a redundant newline.
    let lastWasBreak = false;
    const flushAnchor = () => {
        if (anchor !== undefined) {
            const label = decodeEntities(anchorBuf).replace(/\s+/g, ' ').trim();
            if (options.extractLinks && anchor.href !== '') {
                links.push({ text: label, href: anchor.href });
            }
            if (markdown && anchor.href !== '') {
                out += `[${label}](${anchor.href})`;
            }
            else {
                out += label;
            }
            anchor = undefined;
            anchorBuf = '';
        }
    };
    const emit = (text) => {
        if (preDepth > 0) {
            out += text;
            return;
        }
        const clean = normalizeWhitespace(text);
        if (clean === '')
            return;
        if (anchor !== undefined) {
            anchorBuf += clean + ' ';
            return;
        }
        flushAnchor();
        out += (listMarker !== '' ? listMarker : '') + clean + (listMarker !== '' ? '' : ' ');
        listMarker = '';
        lastWasBreak = false;
    };
    const ensureBreak = () => {
        if (lastWasBreak)
            return;
        if (preDepth > 0)
            return;
        flushAnchor();
        out = out.replace(/[ \t]+$/, '');
        if (!out.endsWith('\n'))
            out += '\n';
        lastWasBreak = true;
        listMarker = '';
    };
    // Walk comments and tags; everything between them is text.
    const tokenRe = /<!--[\s\S]*?-->|<[^>]*>|(?:[^<]+)/g;
    for (const token of html.matchAll(tokenRe)) {
        const chunk = token[0];
        if (chunk.startsWith('<!--'))
            continue;
        if (chunk.startsWith('<')) {
            const closing = chunk.startsWith('</');
            const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(chunk);
            if (tagMatch?.[1] === undefined)
                continue; // <!doctype> and friends
            const tagName = tagMatch[1].toLowerCase();
            const attributes = closing ? undefined : parseAttributes(chunk.slice(1));
            if (!closing) {
                if (tagName === 'title') {
                    inTitle = true;
                    titleBuf = '';
                    continue;
                }
                if (inTitle)
                    continue;
                if (tagName === 'meta') {
                    continue;
                }
                if (tagName === 'a' && attributes !== undefined) {
                    flushAnchor();
                    anchor = { href: attributes.get('href') ?? '' };
                    anchorBuf = '';
                    continue;
                }
                if (tagName === 'img' && attributes !== undefined) {
                    const alt = attributes.get('alt') ?? '';
                    const src = attributes.get('src') ?? '';
                    flushAnchor();
                    if (markdown && src !== '') {
                        out += `![${alt.trim()}](${src}) `;
                    }
                    else if (alt.trim() !== '') {
                        out += alt.trim() + ' ';
                    }
                    continue;
                }
                if (tagName === 'br') {
                    ensureBreak();
                    continue;
                }
                if (tagName === 'hr') {
                    ensureBreak();
                    out += markdown ? '---\n' : '\n';
                    continue;
                }
                if (tagName === 'li') {
                    flushAnchor();
                    ensureBreak();
                    listMarker = markdown ? '- ' : '';
                    continue;
                }
                const headingLevel = HEADING_TAGS[tagName];
                if (headingLevel !== undefined && attributes !== undefined) {
                    flushAnchor();
                    ensureBreak();
                    if (markdown)
                        out += '#'.repeat(headingLevel) + ' ';
                    continue;
                }
                if (tagName === 'pre' || tagName === 'code') {
                    preDepth += 1;
                    if (tagName === 'pre') {
                        flushAnchor();
                        ensureBreak();
                        if (markdown)
                            out += '```\n';
                    }
                    continue;
                }
                if (SKIP_TAGS.has(tagName)) {
                    skipDepth += 1;
                    continue;
                }
                if (BLOCK_TAGS.has(tagName) && !VOID_TAGS.has(tagName)) {
                    flushAnchor();
                    ensureBreak();
                    continue;
                }
                continue;
            }
            // Closing tag
            if (tagName === 'title' && inTitle) {
                title = decodeEntities(titleBuf).replace(/\s+/g, ' ').trim();
                titleBuf = '';
                inTitle = false;
                continue;
            }
            if (inTitle)
                continue;
            if (tagName === 'a') {
                flushAnchor();
                continue;
            }
            if (tagName === 'li') {
                flushAnchor();
                ensureBreak();
                continue;
            }
            if (tagName in HEADING_TAGS) {
                flushAnchor();
                ensureBreak();
                continue;
            }
            if (tagName === 'pre' || tagName === 'code') {
                if (preDepth > 0)
                    preDepth -= 1;
                if (tagName === 'pre') {
                    flushAnchor();
                    out = out.replace(/[ \t]+$/, '');
                    if (markdown && !out.endsWith('```\n'))
                        out += '\n```';
                    ensureBreak();
                }
                continue;
            }
            if (SKIP_TAGS.has(tagName)) {
                if (skipDepth > 0)
                    skipDepth -= 1;
                continue;
            }
            if (BLOCK_TAGS.has(tagName)) {
                flushAnchor();
                ensureBreak();
                continue;
            }
            continue;
        }
        // Text node
        if (inTitle) {
            titleBuf += chunk;
            continue;
        }
        if (skipDepth > 0)
            continue;
        emit(decodeEntities(chunk));
    }
    flushAnchor();
    let content = normalizeWhitespace(out);
    // Rebuild spaces lost by markdown constructs (links, images) adjacency.
    content = content.replace(/\]\(([^)]*)\)\s+(?=[^\s])/g, ']($1) ').replace(/ {2,}/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const truncated = content.length > options.maxChars;
    if (truncated)
        content = content.slice(0, options.maxChars);
    return { title, content, links, truncated };
}
//# sourceMappingURL=html.js.map