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
/** Default number of URLs returned by web_sitemap. */
export declare const DEFAULT_MAX_URLS = 100;
/** Hard upper bound for maxUrls. */
export declare const MAX_URLS_LIMIT = 1000;
/** Default number of sitemap documents fetched by web_sitemap. */
export declare const DEFAULT_MAX_SITEMAPS = 5;
/** Hard upper bound for maxSitemaps. */
export declare const MAX_SITEMAPS_LIMIT = 20;
/** Nested sitemap indexes are followed at most this deep (0 = seeds only). */
export declare const MAX_SITEMAP_DEPTH = 2;
/** Per-value cap for a `<loc>` (keeps a hostile document from bloating output). */
export declare const MAX_LOC_CHARS = 2000;
/** Per-value cap for `<lastmod>`. */
export declare const MAX_LASTMOD_CHARS = 40;
/** Per-value cap for `<changefreq>`. */
export declare const MAX_CHANGEFREQ_CHARS = 20;
/** One `<url>` entry of a sitemap ('' when the element is absent). */
export interface SitemapUrl {
    loc: string;
    lastmod: string;
    changefreq: string;
    priority: number | null;
}
/** Result of parsing one sitemap document. */
export interface ParsedSitemap {
    kind: 'urlset' | 'sitemapindex';
    urls: SitemapUrl[];
    sitemaps: string[];
}
/** Result of parsing a robots.txt document. */
export interface ParsedRobots {
    /** `Sitemap:` directive values, in document order, deduplicated. */
    sitemaps: string[];
    /** First `Crawl-delay:` value ('' when absent). */
    crawlDelay: string;
}
/**
 * Fold a priority to a printable number: two decimals, and `-0` folded to `0`
 * so a JSON round-trip never reports "lost information" for a plain zero.
 */
export declare function roundPriority(value: number): number;
/**
 * Parse a robots.txt document: the `Sitemap:` directives (used to discover
 * sitemaps) and the first `Crawl-delay:`. Comments (`#…`) and `User-agent`
 * scoping are intentionally ignored — Sitemap directives are global.
 */
export declare function parseRobots(text: string): ParsedRobots;
/**
 * Parse a sitemap document. Throws when the root element is neither
 * `<urlset>` nor `<sitemapindex>` — a plain web page is not a sitemap, and
 * guessing would silently produce an empty inventory.
 */
export declare function parseSitemap(xml: string): ParsedSitemap;
/**
 * True when the URL itself looks like a sitemap (`.xml`, `.xml.gz` or a path
 * containing "sitemap") — such an input is read directly instead of going
 * through robots.txt discovery.
 */
export declare function isSitemapLike(input: string): boolean;
//# sourceMappingURL=sitemap.d.ts.map