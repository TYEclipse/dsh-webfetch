/**
 * HTML table extraction for dsh-webfetch: a dependency-free walker that
 * turns `<table>` elements into structured grids (rows of cell strings) for
 * LLM consumption, complementing the prose extractor in ./html.ts.
 *
 * Documented semantics:
 * - only outermost tables are emitted; a nested table contributes its text
 *   content to the containing cell (flattened, no separate entry)
 * - `colspan` / `rowspan` expand into a rectangular grid; a spanning cell's
 *   text is repeated in every slot it covers (rows stay self-contained)
 * - the first row is reported as `header` when it sits inside `<thead>` or
 *   when every one of its cells is a `<th>`; otherwise `header` is empty and
 *   all rows are data rows
 * - cell text is entity-decoded and whitespace-normalized to single spaces;
 *   cells longer than MAX_CELL_CHARS are truncated with an ellipsis
 * - tables without any cell are ignored; script/style/noscript/template
 *   content never contributes text (their raw content is skipped entirely,
 *   so markup that looks like `</table>` inside a script cannot derail the
 *   nesting state)
 *
 * @module dsh-webfetch/table
 */
/** Cell text cap in characters (longer cells are truncated with an ellipsis). */
export declare const MAX_CELL_CHARS = 200;
/** One extracted table (emission order, 1-based `index`). */
export interface ExtractedTable {
    /** 1-based position among the emitted (non-empty) tables of the page. */
    index: number;
    /** `<caption>` text when present, otherwise an empty string. */
    caption: string;
    /** Column count of the expanded rectangular grid. */
    cols: number;
    /** Header row (grid-expanded) when the first row qualifies, otherwise empty. */
    header: string[];
    /** Data rows (grid-expanded, padded to `cols`). */
    rows: string[][];
}
/** Extraction options (caps applied while walking). */
export interface TableExtractOptions {
    /** Max tables to build and return (1-based scan cap). */
    maxTables: number;
    /** Max data rows per table. */
    maxRows: number;
}
/** Extraction result across the whole document. */
export interface TableExtractResult {
    tables: ExtractedTable[];
    /** Number of non-empty tables found in the page (may exceed `tables.length`). */
    totalTables: number;
    /** True when a cap (tables or rows) cut content. */
    truncated: boolean;
    /** True when a per-table row cap cut content (subset of `truncated`). */
    rowsCapped: boolean;
}
/**
 * Extract every (outermost) table of an HTML document, capped by
 * `maxTables` / `maxRows`. Pure string processing — no DOM, no network.
 */
export declare function extractTables(html: string, options: TableExtractOptions): TableExtractResult;
//# sourceMappingURL=table.d.ts.map