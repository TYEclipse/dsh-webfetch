/**
 * Tests for tool definition assembly, config resolution and renderers.
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/index.ts'
import { buildWebfetchTools } from '../src/tools.ts'

describe('resolveConfig', () => {
  it('applies every default', () => {
    const resolved = resolveConfig({})
    expect(resolved).toEqual({
      timeoutMs: 10_000,
      maxBytes: 1_500_000,
      maxChars: 50_000,
      maxRedirects: 3,
      userAgent: 'dsh-webfetch/0.1 (DeepSeek Harness plugin)',
    })
  })

  it('honours overrides', () => {
    const resolved = resolveConfig({ timeoutMs: 2_000, maxRedirects: 5, maxChars: 10_000 })
    expect(resolved.timeoutMs).toBe(2_000)
    expect(resolved.maxRedirects).toBe(5)
    expect(resolved.maxChars).toBe(10_000)
    expect(resolved.maxBytes).toBe(1_500_000)
  })
})

describe('buildWebfetchTools', () => {
  const tools = buildWebfetchTools(resolveConfig({}))

  it('exposes both tools under their canonical names', () => {
    expect(Object.keys(tools).sort()).toEqual(['web_fetch', 'web_links'])
  })

  it('gives every tool a name, description, schema and executable', () => {
    for (const [key, definition] of Object.entries(tools)) {
      expect(definition.name).toBe(key)
      expect(definition.description.length).toBeGreaterThan(20)
      expect(definition.parameters).toBeDefined()
      expect(definition.output.schema).toBeDefined()
      expect(typeof definition.execute).toBe('function')
    }
  })

  it('renders a fetch result as text with title and content', () => {
    const block = tools.web_fetch.output.render(
      { url: 'https://x.test/' },
      {
        url: 'https://x.test/',
        finalUrl: 'https://x.test/',
        status: 200,
        title: 'Example',
        content: 'body text',
        truncated: false,
      },
    )
    expect(block[0]).toEqual({ type: 'text', text: 'HTTP 200 — title: Example\nbody text' })
  })

  it('renders a links result with the inventory', () => {
    const block = tools.web_links.output.render(
      { url: 'https://x.test/' },
      {
        url: 'https://x.test/',
        finalUrl: 'https://x.test/',
        status: 200,
        count: 1,
        links: [{ text: 'Home', href: 'https://x.test/home' }],
      },
    )
    expect(block[0]?.type).toBe('text')
    const textBlock = block[0] as { type: 'text'; text: string }
    expect(textBlock.text).toContain('Home — https://x.test/home')
  })
})
