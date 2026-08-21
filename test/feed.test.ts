/**
 * Unit tests for the dependency-free RSS 2.0 / Atom feed parser:
 * detection, entry extraction, CDATA handling, entity decoding, markup
 * stripping, link selection and error cases — all offline fixtures.
 */

import { describe, expect, it } from 'vitest'
import { decodeEntities, parseFeed, stripTags, truncateText } from '../src/feed.ts'

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Blog</title>
    <link>https://blog.example.com/</link>
    <description>Just an example</description>
    <item>
      <title>First &amp; foremost post</title>
      <link>/posts/first</link>
      <guid isPermaLink="false">first-post</guid>
      <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
      <dc:creator>Alice</dc:creator>
      <description><![CDATA[<p>Hello <b>world</b> &mdash; caf&eacute; &amp; tea.</p>]]></description>
      <content:encoded><![CDATA[<p>Full body with <strong>markup</strong>.</p>]]></content:encoded>
    </item>
    <item>
      <title>Second post</title>
      <description>Summary two</description>
      <pubDate>Tue, 02 Jan 2024 09:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Third via guid</title>
      <guid>https://blog.example.com/posts/third</guid>
      <description>No link element</description>
    </item>
  </channel>
</rss>`

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom News</title>
  <id>urn:uuid:feed-id</id>
  <updated>2024-01-02T09:00:00Z</updated>
  <entry>
    <title>Atom entry one</title>
    <link rel="self" href="/entries/one.self"/>
    <link rel="alternate" href="/entries/one"/>
    <id>urn:uuid:entry-one</id>
    <published>2024-01-01T10:00:00Z</published>
    <updated>2024-01-01T11:00:00Z</updated>
    <author><name>Bob</name></author>
    <summary type="html">&lt;p&gt;Short &amp; sweet&lt;/p&gt;</summary>
    <content type="html">&lt;div&gt;Long &lt;em&gt;content&lt;/em&gt; body.&lt;/div&gt;</content>
  </entry>
  <entry>
    <title>Atom entry two</title>
    <link href="https://other.example.com/entries/two"/>
    <updated>2024-01-02T09:00:00Z</updated>
    <summary>Plain summary two</summary>
  </entry>
</feed>`

describe('parseFeed RSS 2.0', () => {
  it('detects kind and extracts the channel title', () => {
    const feed = parseFeed(RSS_FIXTURE)
    expect(feed.kind).toBe('rss')
    expect(feed.title).toBe('Example Blog')
    expect(feed.entries).toHaveLength(3)
  })

  it('extracts title, link, date, author and summary with CDATA/entity cleanup', () => {
    const feed = parseFeed(RSS_FIXTURE)
    const first = feed.entries[0]
    expect(first?.title).toBe('First & foremost post')
    expect(first?.url).toBe('/posts/first')
    expect(first?.published).toBe('Mon, 01 Jan 2024 10:00:00 GMT')
    expect(first?.author).toBe('Alice')
    expect(first?.summary).toBe('Hello world — café & tea.')
    expect(first?.content).toBe('Full body with markup.')
  })

  it('handles entries missing optional fields', () => {
    const second = parseFeed(RSS_FIXTURE).entries[1]
    expect(second?.title).toBe('Second post')
    expect(second?.url).toBe('')
    expect(second?.author).toBe('')
    expect(second?.content).toBe('')
    expect(second?.summary).toBe('Summary two')
  })

  it('falls back to an absolute guid when the link element is absent', () => {
    const third = parseFeed(RSS_FIXTURE).entries[2]
    expect(third?.url).toBe('https://blog.example.com/posts/third')
  })

  it('does not fall back to a non-URL guid', () => {
    const feed = parseFeed(`<rss version="2.0"><channel><title>T</title><item><title>X</title><guid>some-slug</guid></item></channel></rss>`)
    expect(feed.entries[0]?.url).toBe('')
  })
})

describe('parseFeed Atom', () => {
  it('detects kind and extracts the feed title', () => {
    const feed = parseFeed(ATOM_FIXTURE)
    expect(feed.kind).toBe('atom')
    expect(feed.title).toBe('Atom News')
    expect(feed.entries).toHaveLength(2)
  })

  it('prefers the rel=alternate link over rel=self', () => {
    const first = parseFeed(ATOM_FIXTURE).entries[0]
    expect(first?.url).toBe('/entries/one')
  })

  it('uses the first link when only one exists', () => {
    const second = parseFeed(ATOM_FIXTURE).entries[1]
    expect(second?.url).toBe('https://other.example.com/entries/two')
  })

  it('extracts published/updated, author name, summary and content with entity cleanup', () => {
    const first = parseFeed(ATOM_FIXTURE).entries[0]
    expect(first?.published).toBe('2024-01-01T10:00:00Z')
    expect(first?.author).toBe('Bob')
    expect(first?.summary).toBe('Short & sweet')
    expect(first?.content).toBe('Long content body.')
  })
})

describe('parseFeed errors and tolerance', () => {
  it('throws on a document without a feed root', () => {
    expect(() => parseFeed('<html><body><p>not a feed</p></body></html>')).toThrow(/not a recognized RSS or Atom feed/)
  })

  it('throws on an empty document', () => {
    expect(() => parseFeed('')).toThrow(/not a recognized RSS or Atom feed/)
  })

  it('treats an untitled entry as (untitled)', () => {
    const feed = parseFeed(`<rss version="2.0"><channel><title>T</title><item><link>https://x.test/a</link></item></channel></rss>`)
    expect(feed.entries[0]?.title).toBe('(untitled)')
  })

  it('ignores malformed items without crashing', () => {
    const feed = parseFeed('<rss version="2.0"><channel><title>T</title><item><title>ok</title><link>https://x.test/a</link></item><item><title>broken</title></channel></rss>')
    expect(feed.entries).toHaveLength(1)
    expect(feed.entries[0]?.url).toBe('https://x.test/a')
  })
})

describe('text helpers', () => {
  it('decodes named, decimal and hexadecimal entities', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;&#233;&#xE9;&nbsp;')).toBe('&<>"\'éé\u00a0')
  })

  it('leaves unknown entities untouched', () => {
    expect(decodeEntities('&unknown;')).toBe('&unknown;')
  })

  it('rejects out-of-range numeric entities', () => {
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;')
  })

  it('strips tags and converts block closers and <br> to newlines', () => {
    expect(stripTags('<p>a</p><p>b<br/>c</p>')).toBe('a\nb\nc\n')
  })

  it('truncates long text with an ellipsis and keeps short text intact', () => {
    expect(truncateText('1234567890', 5)).toBe('12345…')
    expect(truncateText('abc', 5)).toBe('abc')
  })
})
