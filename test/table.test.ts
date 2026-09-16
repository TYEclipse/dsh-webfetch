/**
 * Tests for src/table.ts — HTML table extraction.
 *
 * Expected values are anchored to the independent oracle in
 * `test/anchors-table.py` (stdlib html.parser implementation of the same
 * documented semantics; a different parsing engine than the TypeScript
 * walker, so agreement is meaningful). The `rowsCapped` field is derived
 * metadata not emitted by the oracle: false everywhere except the row-cap
 * fixture. To regenerate: `python3 test/anchors-table.py`.
 */

import { describe, expect, it } from 'vitest'
import { extractTables, MAX_CELL_CHARS } from '../src/table.ts'

const extract = (html: string) => extractTables(html, { maxTables: 10, maxRows: 100 })

describe('extractTables (oracle-anchored fixtures)', () => {
  it('F1 parses a simple thead/tbody table', () => {
    const html = '<table><thead><tr><th>Name</th><th>Score</th></tr></thead>'
      + '<tbody><tr><td>Ann</td><td>90</td></tr><tr><td>Bob</td><td>85</td></tr></tbody></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 2, header: ['Name', 'Score'], rows: [['Ann', '90'], ['Bob', '85']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F2 treats an all-th first row as the header (no thead)', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 2, header: ['A', 'B'], rows: [['1', '2']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F3 reports no header for an all-td first row', () => {
    const html = '<table><tr><td>x</td><td>y</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 2, header: [], rows: [['x', 'y']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F4 expands a colspan header and repeats the spanning text', () => {
    const html = '<table><tr><th>A</th><th colspan="2">Group B</th></tr>'
      + '<tr><td>1</td><td>2</td><td>3</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 3, header: ['A', 'Group B', 'Group B'], rows: [['1', '2', '3']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F5 fills a rowspan across the following row', () => {
    const html = '<table><tr><td rowspan="2">x</td><td>1</td></tr><tr><td>2</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 2, header: [], rows: [['x', '1'], ['x', '2']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F6 combines colspan and rowspan in one grid', () => {
    const html = '<table><tr><th rowspan="2">H</th><th colspan="2">Top</th></tr>'
      + '<tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td><td>e</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 3, header: ['H', 'Top', 'Top'], rows: [['H', 'a', 'b'], ['c', 'd', 'e']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F7 flattens a nested table into the containing cell', () => {
    const html = '<table><tr><td>outer <table><tr><td>in1</td><td>in2</td></tr></table> end</td>'
      + '<td>right</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 2, header: [], rows: [['outer in1 in2 end', 'right']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F8 captures the caption and decodes entities in cells', () => {
    const html = '<table><caption>Sales &amp; Costs 2024</caption>'
      + '<tr><th>Item</th></tr><tr><td>A&nbsp;B &#169;</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: 'Sales & Costs 2024', cols: 1, header: ['Item'], rows: [['A B ©']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F9 turns <br> into a space and normalizes whitespace', () => {
    const html = '<table><tr><td>line1<br>line2</td><td>  padded   text </td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 2, header: [], rows: [['line1 line2', 'padded text']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F13 never lets script/style content reach a cell', () => {
    const html = '<table><tr><td>ok<script>evil()</script><style>.x{}</style></td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 1, header: [], rows: [['ok']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F14 recovers from implicit cell/row closes (malformed HTML)', () => {
    expect(extract('<table><tr><td>a<td>b</table>')).toEqual({
      tables: [{ index: 1, caption: '', cols: 2, header: [], rows: [['a', 'b']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F15 skips an empty table and keeps page order for the rest', () => {
    const html = '<table></table><table><tr><td>real</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 1, header: [], rows: [['real']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F16 treats a thead row as the header even with td cells', () => {
    const html = '<table><thead><tr><td>P</td><td>Q</td></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 2, header: ['P', 'Q'], rows: [['1', '2']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F17 does not treat a mixed th/td first row as a header', () => {
    const html = '<table><tr><th>A</th><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 2, header: [], rows: [['A', 'b'], ['1', '2']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F19 accepts uppercase tags', () => {
    expect(extract('<TABLE><TR><TD>Up</TD></TR></TABLE>')).toEqual({
      tables: [{ index: 1, caption: '', cols: 1, header: [], rows: [['Up']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F21 ignores table-like markup inside a script string', () => {
    const html = '<table><tr><td>ok</td></tr></table>'
      + '<script>var s = "</table><table><tr><td>fake</td></tr>";</script>'
      + '<table><tr><td>second</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [
        { index: 1, caption: '', cols: 1, header: [], rows: [['ok']] },
        { index: 2, caption: '', cols: 1, header: [], rows: [['second']] },
      ],
      totalTables: 2,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F22 pads ragged rows to the widest one', () => {
    const html = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 2, header: [], rows: [['a', 'b'], ['c', '']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('F23 flushes an unclosed table at end of input', () => {
    expect(extract('<table><tr><td>only</td></tr>')).toEqual({
      tables: [{ index: 1, caption: '', cols: 1, header: [], rows: [['only']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })

  it('returns an empty result for a page without tables', () => {
    expect(extract('<html><body><p>no tables here</p></body></html>')).toEqual({
      tables: [],
      totalTables: 0,
      truncated: false,
      rowsCapped: false,
    })
  })
})

describe('extractTables caps', () => {
  it('C1 caps data rows per table and flags the cut', () => {
    const html = `<table>${Array.from({ length: 60 }, (_, i) => `<tr><td>r${i + 1}</td></tr>`).join('')}</table>`
    const result = extractTables(html, { maxTables: 10, maxRows: 50 })
    expect(result.totalTables).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.rowsCapped).toBe(true)
    expect(result.tables[0]?.rows).toHaveLength(50)
    expect(result.tables[0]?.rows[0]).toEqual(['r1'])
    expect(result.tables[0]?.rows[49]).toEqual(['r50'])
  })

  it('C2 caps the table list and flags the cut without a row cap', () => {
    const html = Array.from({ length: 7 }, (_, i) => `<table><tr><td>t${i + 1}</td></tr></table>`).join('')
    const result = extractTables(html, { maxTables: 5, maxRows: 100 })
    expect(result.totalTables).toBe(7)
    expect(result.truncated).toBe(true)
    expect(result.rowsCapped).toBe(false)
    expect(result.tables).toHaveLength(5)
    expect(result.tables[4]).toEqual({ index: 5, caption: '', cols: 1, header: [], rows: [['t5']] })
  })

  it('C3 truncates an oversized cell to MAX_CELL_CHARS + ellipsis', () => {
    expect(MAX_CELL_CHARS).toBe(200)
    const result = extractTables(`<table><tr><td>${'a'.repeat(250)}</td></tr></table>`, { maxTables: 10, maxRows: 100 })
    expect(result.tables[0]?.rows[0]?.[0]).toBe(`${'a'.repeat(200)}…`)
  })

  it('caps a pathological colspan at 100 columns', () => {
    const html = '<table><tr><td colspan="9999">wide</td></tr></table>'
    const result = extract(html)
    expect(result.tables[0]?.cols).toBe(100)
    expect(result.tables[0]?.rows[0]?.[99]).toBe('wide')
  })

  it('treats invalid span values as 1', () => {
    const html = '<table><tr><td colspan="0">a</td><td colspan="x">b</td><td rowspan="-3">c</td></tr></table>'
    expect(extract(html)).toEqual({
      tables: [{ index: 1, caption: '', cols: 3, header: [], rows: [['a', 'b', 'c']] }],
      totalTables: 1,
      truncated: false,
      rowsCapped: false,
    })
  })
})
