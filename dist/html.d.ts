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
/** A link discovered while parsing. */
export interface LinkRef {
    /** Visible label of the link (may be empty for image-only links). */
    text: string;
    /** href attribute, exactly as written in the page (may be relative). */
    href: string;
}
/** Extraction options. */
export interface ExtractOptions {
    /** Rendering style: 'markdown' keeps link targets, headings and lists; 'text' is plain prose. */
    format: 'markdown' | 'text';
    /** Hard cap on the extracted content length in characters. */
    maxChars: number;
    /** Collect links while parsing. */
    extractLinks: boolean;
}
/** Result of extraction. */
export interface ExtractedPage {
    title: string;
    content: string;
    links: LinkRef[];
    truncated: boolean;
}
/** Decode HTML entities (named table above plus numeric &#123; / &#x1F600;). */
export declare function decodeEntities(input: string): string;
/**
 * Extract readable content from an HTML document.
 * Comments, scripts, styles and embedded content are dropped; block structure
 * is preserved as newlines (plus markdown syntax in markdown mode).
 */
export declare function extractPage(html: string, options: ExtractOptions): ExtractedPage;
//# sourceMappingURL=html.d.ts.map