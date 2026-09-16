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

import { decodeEntities } from './html.ts'

/** Cell text cap in characters (longer cells are truncated with an ellipsis). */
export const MAX_CELL_CHARS = 200

/** One extracted table (emission order, 1-based `index`). */
export interface ExtractedTable {
  /** 1-based position among the emitted (non-empty) tables of the page. */
  index: number
  /** `<caption>` text when present, otherwise an empty string. */
  caption: string
  /** Column count of the expanded rectangular grid. */
  cols: number
  /** Header row (grid-expanded) when the first row qualifies, otherwise empty. */
  header: string[]
  /** Data rows (grid-expanded, padded to `cols`). */
  rows: string[][]
}

/** Extraction options (caps applied while walking). */
export interface TableExtractOptions {
  /** Max tables to build and return (1-based scan cap). */
  maxTables: number
  /** Max data rows per table. */
  maxRows: number
}

/** Extraction result across the whole document. */
export interface TableExtractResult {
  tables: ExtractedTable[]
  /** Number of non-empty tables found in the page (may exceed `tables.length`). */
  totalTables: number
  /** True when a cap (tables or rows) cut content. */
  truncated: boolean
  /** True when a per-table row cap cut content (subset of `truncated`). */
  rowsCapped: boolean
}

interface RawCell {
  text: string
  colspan: number
  rowspan: number
  isHeader: boolean
}

interface RawRow {
  cells: RawCell[]
  inThead: boolean
}

/** Raw-text elements whose content (text and tags) is skipped entirely. */
const RAW_SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template'])

/** Elements whose text never contributes to cells (tags are still tracked). */
const TEXT_SKIP_TAGS = new Set([
  'svg', 'math', 'select', 'textarea', 'iframe', 'object', 'canvas',
  'audio', 'video', 'head', 'title',
])

/** Decode entities and collapse whitespace runs to single spaces. */
function normalizeText(input: string): string {
  return decodeEntities(input).replace(/\s+/g, ' ').trim()
}

/** Parse a colspan/rowspan attribute: integer >= 2 counts, everything else is 1 (capped at 100). */
function parseSpan(raw: string | undefined): number {
  if (raw === undefined) return 1
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= 2 ? Math.min(value, 100) : 1
}

/** Parse the attribute list of an opening tag into a lookup map. */
function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>()
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of raw.matchAll(attrRe)) {
    const attrName = match[1]
    if (attrName === undefined) continue
    attrs.set(attrName.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

/**
 * Expand raw rows (with spans) into a rectangular-ready grid. A spanning
 * cell's text is repeated in every slot it covers; slots never covered stay
 * missing until the final padding pass in `buildTable`.
 */
function buildGrid(rows: RawRow[]): string[][] {
  const grid: string[][] = []
  // Column -> carry-over value for an active rowspan.
  const pending = new Map<number, { text: string; remaining: number }>()
  for (const row of rows) {
    const out: string[] = []
    let col = 0
    const placePending = (): void => {
      let p = pending.get(col)
      while (p !== undefined && p.remaining > 0) {
        out[col] = p.text
        p.remaining -= 1
        if (p.remaining === 0) pending.delete(col)
        col += 1
        p = pending.get(col)
      }
    }
    for (const cell of row.cells) {
      placePending()
      for (let k = 0; k < cell.colspan; k += 1) out[col + k] = cell.text
      if (cell.rowspan > 1) {
        for (let k = 0; k < cell.colspan; k += 1) {
          pending.set(col + k, { text: cell.text, remaining: cell.rowspan - 1 })
        }
      }
      col += cell.colspan
    }
    placePending()
    grid.push(out)
  }
  return grid
}

/** Build an ExtractedTable from raw rows: grid expansion, header detection, row cap. */
function buildTable(rows: RawRow[], caption: string, index: number, maxRows: number): { table: ExtractedTable; rowCapped: boolean } {
  const grid = buildGrid(rows)
  let cols = 0
  for (const row of grid) cols = Math.max(cols, row.length)
  for (const row of grid) {
    while (row.length < cols) row.push('')
  }
  const first = rows[0]
  const headerRow = first !== undefined && (first.inThead || first.cells.every((cell) => cell.isHeader))
  const header = headerRow ? grid[0] ?? [] : []
  let body = headerRow ? grid.slice(1) : grid
  let rowCapped = false
  if (body.length > maxRows) {
    body = body.slice(0, maxRows)
    rowCapped = true
  }
  return { table: { index, caption, cols, header, rows: body }, rowCapped }
}

/**
 * Extract every (outermost) table of an HTML document, capped by
 * `maxTables` / `maxRows`. Pure string processing — no DOM, no network.
 */
export function extractTables(html: string, options: TableExtractOptions): TableExtractResult {
  const maxTables = Math.max(1, options.maxTables)
  const maxRows = Math.max(1, options.maxRows)
  const tables: ExtractedTable[] = []
  let totalTables = 0
  let rowCappedAny = false

  // Walker state.
  let tableDepth = 0
  let rows: RawRow[] | undefined
  let rowCells: RawCell[] | undefined
  let rowInThead = false
  let inThead = false
  let cell: { text: string; isHeader: boolean; colspan: number; rowspan: number } | undefined
  let captionBuf: string | undefined
  let inCaption = false
  let rawSkip: string | undefined
  let skipDepth = 0

  const flushCell = (): void => {
    if (cell === undefined) return
    let text = normalizeText(cell.text)
    if (text.length > MAX_CELL_CHARS) text = `${text.slice(0, MAX_CELL_CHARS)}…`
    rowCells ??= []
    rowCells.push({ text, colspan: cell.colspan, rowspan: cell.rowspan, isHeader: cell.isHeader })
    cell = undefined
  }

  const flushRow = (): void => {
    flushCell()
    if (rowCells !== undefined && rowCells.length > 0 && rows !== undefined) {
      rows.push({ cells: rowCells, inThead: rowInThead })
    }
    rowCells = undefined
  }

  const closeTable = (): void => {
    flushRow()
    if (rows !== undefined) {
      const hasCells = rows.some((row) => row.cells.length > 0)
      if (hasCells) {
        totalTables += 1
        if (tables.length < maxTables) {
          const caption = captionBuf !== undefined ? normalizeText(captionBuf).slice(0, MAX_CELL_CHARS) : ''
          const built = buildTable(rows, caption, tables.length + 1, maxRows)
          tables.push(built.table)
          if (built.rowCapped) rowCappedAny = true
        }
      }
    }
    rows = undefined
    rowCells = undefined
    cell = undefined
    captionBuf = undefined
    inCaption = false
    inThead = false
  }

  const tokenRe = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g
  for (const token of html.matchAll(tokenRe)) {
    const chunk = token[0]
    if (chunk.startsWith('<!--')) continue

    // Inside a raw-text element (script/style/…): only the matching close tag matters.
    if (rawSkip !== undefined) {
      if (chunk.startsWith('</')) {
        const match = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(chunk)
        if (match?.[1]?.toLowerCase() === rawSkip) rawSkip = undefined
      }
      continue
    }

    if (chunk.startsWith('<')) {
      const closing = chunk.startsWith('</')
      const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(chunk)
      if (tagMatch?.[1] === undefined) continue
      const tagName = tagMatch[1].toLowerCase()
      const attributes = closing ? undefined : parseAttributes(chunk.slice(1))

      if (!closing && RAW_SKIP_TAGS.has(tagName)) {
        rawSkip = tagName
        continue
      }

      if (closing) {
        if (TEXT_SKIP_TAGS.has(tagName)) {
          if (skipDepth > 0) skipDepth -= 1
          continue
        }
        if (skipDepth > 0) continue
        if (tagName === 'table') {
          if (tableDepth > 0) {
            if (tableDepth === 1) closeTable()
            tableDepth -= 1
          }
        } else if (tableDepth === 1) {
          if (tagName === 'tr') flushRow()
          else if (tagName === 'td' || tagName === 'th') flushCell()
          else if (tagName === 'thead') {
            flushRow()
            inThead = false
          } else if (tagName === 'tbody' || tagName === 'tfoot') flushRow()
          else if (tagName === 'caption') inCaption = false
        }
        continue
      }

      if (TEXT_SKIP_TAGS.has(tagName)) {
        skipDepth += 1
        continue
      }
      if (skipDepth > 0) continue

      if (tagName === 'br') {
        if (inCaption && captionBuf !== undefined) captionBuf += ' '
        else if (cell !== undefined) cell.text += ' '
        continue
      }

      if (tagName === 'table') {
        tableDepth += 1
        if (tableDepth === 1) {
          rows = []
          rowCells = undefined
          rowInThead = false
          inThead = false
          cell = undefined
          captionBuf = undefined
          inCaption = false
        }
        continue
      }

      if (tableDepth === 1) {
        if (tagName === 'caption') {
          if (captionBuf === undefined) {
            inCaption = true
            captionBuf = ''
          }
        } else if (tagName === 'thead') {
          inThead = true
        } else if (tagName === 'tbody' || tagName === 'tfoot') {
          inThead = false
        } else if (tagName === 'tr') {
          flushRow()
          rowInThead = inThead
        } else if (tagName === 'td' || tagName === 'th') {
          flushCell()
          rowCells ??= []
          cell = {
            text: '',
            isHeader: tagName === 'th',
            colspan: parseSpan(attributes?.get('colspan')),
            rowspan: parseSpan(attributes?.get('rowspan')),
          }
        }
      } else if (tableDepth > 1 && (tagName === 'td' || tagName === 'th') && cell !== undefined) {
        // Nested table: cell boundaries become separators in the flattened text.
        cell.text += ' '
      }
      continue
    }

    // Text node.
    if (skipDepth > 0) continue
    if (inCaption && captionBuf !== undefined) {
      captionBuf += chunk
      continue
    }
    if (cell !== undefined) cell.text += chunk
  }

  if (rows !== undefined) {
    closeTable()
    tableDepth = 0
  }

  return { tables, totalTables, truncated: tables.length < totalTables || rowCappedAny, rowsCapped: rowCappedAny }
}
