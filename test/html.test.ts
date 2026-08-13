/**
 * Offline unit tests for the HTML-to-text extractor: entities, tag skipping,
 * markdown constructs, links, truncation and whitespace normalization.
 */

import { describe, expect, it } from 'vitest'
import { decodeEntities, extractPage } from '../src/html.ts'
import { resolveHref } from '../src/fetch.ts'

const md = (html: string, maxChars = 10_000) => extractPage(html, { format: 'markdown', maxChars, extractLinks: true })

describe('decodeEntities', () => {
  it('decodes named and numeric entities, leaves unknown ones alone', () => {
    expect(decodeEntities('a &amp; b &lt;tag&gt;')).toBe('a & b <tag>')
    expect(decodeEntities('&#65;&#x42;&#X43;')).toBe('ABC')
    expect(decodeEntities('&nbsp;caf&eacute; &mdash; end')).toBe(' caf\u00e9 \u2014 end')
    expect(decodeEntities('&unknown1;')).toBe('&unknown1;')
    expect(decodeEntities('&#99999999999;')).toBe('&#99999999999;')
  })
})

describe('extractPage — structure', () => {
  it('extracts the title and body text', () => {
    const page = md('<html><head><title>Hello World</title></head><body><p>First paragraph.</p></body></html>')
    expect(page.title).toBe('Hello World')
    expect(page.content).toContain('First paragraph.')
  })

  it('drops scripts, styles, comments and embedded content', () => {
    const page = md(
      '<p>keep</p><script>alert("drop me")</script><style>.x{}</style><!-- comment -->'
      + '<noscript>drop too</noscript><svg><text>drop</text></svg><p>and me</p>',
    )
    expect(page.content).toContain('keep')
    expect(page.content).toContain('and me')
    expect(page.content).not.toContain('drop me')
    expect(page.content).not.toContain('drop too')
    expect(page.content).not.toContain('.x{}')
  })

  it('separates block elements with newlines', () => {
    const page = md('<div>alpha</div><div>beta</div>')
    expect(page.content).toMatch(/alpha\nbeta/)
  })

  it('renders headings, lists and code fences in markdown mode', () => {
    const page = md('<h2>Title</h2><ul><li>one</li><li>two</li></ul><pre><code>const x = 1;</code></pre>')
    expect(page.content).toContain('## Title')
    expect(page.content).toContain('- one')
    expect(page.content).toContain('- two')
    expect(page.content).toContain('```')
    expect(page.content).toContain('const x = 1;')
  })

  it('keeps plain text mode free of markdown syntax', () => {
    const page = extractPage('<h1>Head</h1><p>See <a href="/x">here</a>.</p>', { format: 'text', maxChars: 10_000, extractLinks: false })
    expect(page.content).not.toContain('#')
    expect(page.content).not.toContain('](')
    expect(page.content).toContain('here')
  })
})

describe('extractPage — links', () => {
  it('collects links with labels when requested', () => {
    const page = md('<a href="/a">Alpha</a> <a href="/b"></a> <a href="/c"><img src="i.png" alt="pic"></a>')
    expect(page.links).toEqual([
      { text: 'Alpha', href: '/a' },
      { text: '', href: '/b' },
      { text: '', href: '/c' },
    ])
  })

  it('does not collect links when not requested', () => {
    const page = extractPage('<a href="/a">Alpha</a>', { format: 'markdown', maxChars: 10_000, extractLinks: false })
    expect(page.links).toEqual([])
  })

  it('renders links as markdown in markdown mode', () => {
    const page = md('<p>Read <a href="https://example.com/doc">the docs</a> now.</p>')
    expect(page.content).toContain('[the docs](https://example.com/doc)')
  })

  it('renders images as markdown with alt text', () => {
    const page = md('<p><img src="cat.png" alt="a cat"></p>')
    expect(page.content).toContain('![a cat](cat.png)')
  })
})

describe('extractPage — truncation and whitespace', () => {
  it('truncates at maxChars and reports it', () => {
    const page = md('<p>' + 'x'.repeat(500) + '</p>', 100)
    expect(page.content.length).toBe(100)
    expect(page.truncated).toBe(true)
  })

  it('collapses whitespace and blank lines', () => {
    const page = md('<p>a   b</p><p></p><p>c</p>')
    expect(page.content).toContain('a b')
    expect(page.content).not.toMatch(/\n{3,}/)
  })
})

describe('resolveHref', () => {
  it('resolves relative links against the base and drops junk protocols', () => {
    expect(resolveHref('/path?q=1', 'https://example.com/a/b')).toBe('https://example.com/path?q=1')
    expect(resolveHref('../up', 'https://example.com/a/b/')).toBe('https://example.com/a/up')
    expect(resolveHref('#frag', 'https://example.com')).toBe('')
    expect(resolveHref('javascript:alert(1)', 'https://example.com')).toBe('')
    expect(resolveHref('mailto:x@y.z', 'https://example.com')).toBe('')
    expect(resolveHref('data:text/plain,hi', 'https://example.com')).toBe('')
    expect(resolveHref('file:///etc/passwd', 'https://example.com')).toBe('')
  })
})
