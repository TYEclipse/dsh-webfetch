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
/** Max characters of the document scanned when it has no closing `</head>`. */
export declare const MAX_HEAD_SCAN = 200000;
/** Max characters kept per metadata text value (longer values get an ellipsis). */
export declare const MAX_META_TEXT = 1000;
/** Max link references (alternates, feeds, icons) kept of each kind. */
export declare const MAX_META_REFS = 32;
/** Max JSON-LD blocks parsed and reported. */
export declare const MAX_JSON_LD_BLOCKS = 10;
/** Max characters of a single JSON-LD block accepted for parsing. */
export declare const MAX_JSON_LD_CHARS = 100000;
/** Max `@type` names kept per JSON-LD block. */
export declare const MAX_JSON_LD_TYPES = 8;
/** One `<meta>` property/name pair (Open Graph, article, Twitter). */
export interface MetaEntry {
    /** The `property`/`name` attribute value, lowercased (e.g. `og:image`). */
    name: string;
    /** The `content` attribute value, normalized. */
    content: string;
}
/** An hreflang alternate link. */
export interface AlternateRef {
    /** The `hreflang` attribute (e.g. `en`, `zh-Hans`, `x-default`). */
    hreflang: string;
    /** The `href` attribute, as written on the page. */
    href: string;
}
/** A feed autodiscovery link. */
export interface FeedRef {
    /** MIME type of the link (`application/rss+xml`, `application/atom+xml`, `application/feed+json`). */
    type: string;
    /** The link `title` attribute when present, otherwise an empty string. */
    title: string;
    /** The `href` attribute, as written on the page. */
    href: string;
}
/** One JSON-LD block summary. */
export interface JsonLdBlock {
    /** 1-based position among the non-empty JSON-LD blocks of the page. */
    index: number;
    /** True when the block parsed as JSON. */
    valid: boolean;
    /** `@type` names found at the top level and inside `@graph` (deduplicated). */
    types: string[];
    /** Parser message when `valid` is false (only present for invalid blocks). */
    error?: string;
}
/** Extraction result for a document's head. */
export interface ExtractedMeta {
    title: string;
    description: string;
    canonical: string;
    lang: string;
    charset: string;
    robots: string;
    author: string;
    openGraph: MetaEntry[];
    twitter: MetaEntry[];
    alternates: AlternateRef[];
    feeds: FeedRef[];
    icons: string[];
    jsonLd: JsonLdBlock[];
    /** Number of non-empty JSON-LD blocks found (may exceed `jsonLd.length`). */
    jsonLdCount: number;
    /** Number of JSON-LD blocks that failed to parse or exceeded the size cap. */
    jsonLdInvalid: number;
    /** True when the head scan cap cut the document (no `</head>` in range). */
    truncated: boolean;
}
/** Extraction options. */
export interface MetaExtractOptions {
    /** Max JSON-LD blocks to build and return (1-based scan cap). */
    maxJsonLd: number;
}
/** Extract a document's `<head>` metadata. */
export declare function extractMeta(html: string, options: MetaExtractOptions): ExtractedMeta;
//# sourceMappingURL=meta.d.ts.map