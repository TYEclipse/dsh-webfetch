/**
 * Dependency-free RSS 2.0 / Atom feed parser for dsh-webfetch.
 *
 * Feeds are XML documents; web_fetch's HTML extractor would mangle them, so
 * this module turns a feed document into a plain structured listing of
 * entries (title, link, date, author, summary and optional full content).
 *
 * The parser is intentionally small and defensive: it detects the feed kind
 * from the root element, extracts entry blocks with bounded regexes, strips
 * CDATA/markup, decodes common entities and resolves nothing by itself
 * (link resolution against the feed URL happens in the tool layer). It
 * never executes anything from the document.
 *
 * @module dsh-webfetch/feed
 */

/** One entry of a parsed feed, all fields plain strings ('' when absent). */
export interface FeedEntry {
  title: string
  url: string
  published: string
  author: string
  summary: string
  content: string
}

/** Result of parsing a feed document. */
export interface ParsedFeed {
  kind: 'rss' | 'atom'
  title: string
  entries: FeedEntry[]
}

/** Common named entities found in feed text (HTML4 Latin-1 set + typography). */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  shy: '\u00ad',
  zwnj: '\u200c',
  zwj: '\u200d',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  middot: '\u00b7',
  bull: '\u2022',
  sect: '\u00a7',
  para: '\u00b6',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  curren: '\u00a4',
  micro: '\u00b5',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  aacute: '\u00e1',
  agrave: '\u00e0',
  acirc: '\u00e2',
  atilde: '\u00e3',
  auml: '\u00e4',
  aring: '\u00e5',
  aelig: '\u00e6',
  ccedil: '\u00e7',
  eacute: '\u00e9',
  egrave: '\u00e8',
  ecirc: '\u00ea',
  euml: '\u00eb',
  iacute: '\u00ed',
  igrave: '\u00ec',
  icirc: '\u00ee',
  iuml: '\u00ef',
  ntilde: '\u00f1',
  oacute: '\u00f3',
  ograve: '\u00f2',
  ocirc: '\u00f4',
  otilde: '\u00f5',
  ouml: '\u00f6',
  oslash: '\u00f8',
  uacute: '\u00fa',
  ugrave: '\u00f9',
  ucirc: '\u00fb',
  uuml: '\u00fc',
  yacute: '\u00fd',
  szlig: '\u00df',
}

/** Decode XML/HTML character references: named, decimal and hexadecimal. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x')) {
      const code = parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    const named = NAMED[body]
    return named === undefined ? whole : named
  })
}

/** Remove markup, keeping text: <br> and block closers become newlines. */
export function stripTags(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|pre|section|article)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
}

/** Trim a string to `max` characters, appending an ellipsis when cut. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

/** Clean one extracted text fragment: CDATA, entities, tags, whitespace. */
function cleanText(raw: string): string {
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // Entities first, then tags: entity-escaped markup (&lt;p&gt; in type="html"
  // Atom summaries) must decode into real tags so the tag stripper removes it.
  const decoded = decodeEntities(withoutCdata)
  const withoutTags = stripTags(decoded)
  return withoutTags.replace(/\s+/g, ' ').trim()
}

/** First `<tag>…</tag>` text content of a block ('' when absent). */
function tagText(block: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const match = re.exec(block)
  return match?.[1] === undefined ? '' : cleanText(match[1])
}

/** First capture of `re` in block, cleaned ('' when absent). */
function matchText(block: string, re: RegExp): string {
  const match = re.exec(block)
  return match?.[1] === undefined ? '' : cleanText(match[1])
}

/** Parse one RSS 2.0 <item> block. */
function parseRssItem(item: string): FeedEntry {
  const title = tagText(item, 'title')
  let url = tagText(item, 'link')
  if (url === '') {
    const guid = tagText(item, 'guid')
    if (/^https?:\/\//i.test(guid)) url = guid
  }
  const published = matchText(item, /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i)
    || matchText(item, /<dc:date\b[^>]*>([\s\S]*?)<\/dc:date>/i)
  const author = matchText(item, /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i)
    || matchText(item, /<author\b[^>]*>([\s\S]*?)<\/author>/i)
  const summary = tagText(item, 'description')
  const content = matchText(item, /<content:encoded\b[^>]*>([\s\S]*?)<\/content:encoded>/i)
  return { title: title === '' ? '(untitled)' : title, url, published, author, summary, content }
}

/** Choose the entry link from Atom <link> elements (alternate preferred). */
function pickAtomLink(entry: string): string {
  const links: Array<{ href: string; rel: string }> = []
  const linkRe = /<link\b[^>]*>/gi
  for (const tag of entry.matchAll(linkRe)) {
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0])
    const rel = /rel\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0])
    if (href?.[1] !== undefined || href?.[2] !== undefined) {
      links.push({ href: href?.[1] ?? href?.[2] ?? '', rel: (rel?.[1] ?? rel?.[2] ?? '').toLowerCase() })
    }
  }
  const alternate = links.find((link) => link.rel.includes('alternate'))
  const fallback = links.find((link) => link.rel === '') ?? links[0]
  return (alternate ?? fallback)?.href ?? ''
}

/** Parse one Atom <entry> block. */
function parseAtomEntry(entry: string): FeedEntry {
  const title = tagText(entry, 'title')
  const published = matchText(entry, /<(?:published|updated)\b[^>]*>([\s\S]*?)<\/(?:published|updated)>/i)
  const author = matchText(entry, /<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/i)
  const summary = matchText(entry, /<summary\b[^>]*>([\s\S]*?)<\/summary>/i)
  const content = matchText(entry, /<content\b[^>]*>([\s\S]*?)<\/content>/i)
  return { title: title === '' ? '(untitled)' : title, url: pickAtomLink(entry), published, author, summary, content }
}

/**
 * Parse an RSS 2.0 or Atom feed document. Throws when the document has no
 * recognisable feed root element.
 */
export function parseFeed(xml: string): ParsedFeed {
  if (/<rss[\s>]/i.test(xml)) {
    const channel = /<channel[\s>][\s\S]*?(?=<\/channel>)/i.exec(xml)?.[0] ?? xml
    const title = tagText(channel, 'title')
    const entries: FeedEntry[] = []
    const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi
    for (const match of xml.matchAll(itemRe)) {
      if (match[1] !== undefined) entries.push(parseRssItem(match[1]))
    }
    return { kind: 'rss', title, entries }
  }
  if (/<feed[\s>]/i.test(xml)) {
    const title = tagText(xml, 'title')
    const entries: FeedEntry[] = []
    const entryRe = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi
    for (const match of xml.matchAll(entryRe)) {
      if (match[1] !== undefined) entries.push(parseAtomEntry(match[1]))
    }
    return { kind: 'atom', title, entries }
  }
  throw new Error('not a recognized RSS or Atom feed (no <rss> or <feed> root element found)')
}
