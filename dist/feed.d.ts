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
    title: string;
    url: string;
    published: string;
    author: string;
    summary: string;
    content: string;
}
/** Result of parsing a feed document. */
export interface ParsedFeed {
    kind: 'rss' | 'atom';
    title: string;
    entries: FeedEntry[];
}
/** Decode XML/HTML character references: named, decimal and hexadecimal. */
export declare function decodeEntities(input: string): string;
/** Remove markup, keeping text: <br> and block closers become newlines. */
export declare function stripTags(input: string): string;
/** Trim a string to `max` characters, appending an ellipsis when cut. */
export declare function truncateText(text: string, max: number): string;
/**
 * Parse an RSS 2.0 or Atom feed document. Throws when the document has no
 * recognisable feed root element.
 */
export declare function parseFeed(xml: string): ParsedFeed;
//# sourceMappingURL=feed.d.ts.map