/**
 * Unit and end-to-end tests for the robots.txt rule engine (web_robots):
 * group parsing, user-agent specificity (`*` only as a fallback), `*`/`$`
 * pattern matching, longest-match and Allow-wins-tie precedence (RFC 9309),
 * the honest "no rule matched" and "robots.txt unusable" answers, and the
 * text renderer — all offline fixtures on local servers.
 *
 * ORACLE: test/oracle/anchors.py
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resolveConfig } from '../src/index.ts'
import { buildWebfetchTools } from '../src/tools.ts'
import {
  DEFAULT_MAX_RULES, MAX_RULES_LIMIT, ROBOTS_SIZE_LIMIT,
  evaluateRobots, parseRuleSet, patternMatches, productToken, selectGroups,
} from '../src/robots.ts'
import { assertLossless } from './helpers/lossless-json.ts'

const ROBOTS_RULES = `# rule fixture
User-agent: *
Disallow: /private
Allow: /private/public
Crawl-delay: 10

User-agent: dsh-webfetch
Disallow: /no-webfetch
Allow: /no-webfetch/allowed

User-agent: dsh-webfetch
Disallow: /*.pdf$

User-agent: googlebot
Disallow:

Sitemap: https://example.test/sitemap.xml
Sitemap: https://example.test/sitemap.xml
`

const ROBOTS_TIE = `User-agent: *
Disallow: /tie
Allow: /tie
Disallow: /deeper
Allow: /deeper/ok
`

const ROBOTS_NO_GROUP = `User-agent: googlebot
Disallow: /
`

const ROBOTS_ODD = `Disallow: /orphan
User-agent: *
Disallow: admin
Disallow: /заметки
`

const OUR_UA = 'dsh-webfetch/0.7 (DeepSeek Harness plugin)'
const OTHER_UA = 'otherbot/1.0'

interface RobotsRuleView {
  type: string
  pattern: string
  length: number
  line: number
}

interface RobotsResult {
  url: string
  robotsUrl: string
  robotsStatus: number
  bytes: number
  userAgent: string
  productToken: string
  target: string
  allowed: boolean
  decision: string
  matchedKind: string
  matchedAgents: string[]
  groupCount: number
  ruleCount: number
  ignoredRules: number
  orphanRules: number
  crawlDelay?: string
  sitemaps: string[]
  rules: RobotsRuleView[]
  rule?: RobotsRuleView
  notes: string[]
  truncated: boolean
}

type RobotsArgs = { url: string; path?: string; userAgent?: string; maxRules?: number }

describe('productToken', () => {
  it('takes the product name before the version and the comment', () => {
    expect(productToken(OUR_UA)).toBe('dsh-webfetch')
    expect(productToken(OTHER_UA)).toBe('otherbot')
    expect(productToken('  Googlebot/2.1 (+http://www.google.com/bot.html)  ')).toBe('googlebot')
    expect(productToken('')).toBe('')
  })
})

describe('patternMatches', () => {
  const table: Array<[string, string, boolean]> = [
    ['/private', '/private/x', true],
    ['/private', '/x/private', false],
    ['/*.pdf$', '/a/report.pdf', true],
    ['/*.pdf$', '/a/report.pdf?q=1', false],
    ['/a*b$', '/aXb', true],
    ['/a*b$', '/aXb/', false],
    ['/', '/anything', true],
    ['/', '', false],
    ['/x$', '/x', true],
    ['/x$', '/x/', false],
    ['*', '/whatever', true],
    ['/a$b', '/a$b/x', true],
  ]

  it('anchors at the start, expands * and honours a trailing $', () => {
    for (const [pattern, target, expected] of table) {
      expect(patternMatches(pattern, target), `${pattern} vs ${target}`).toBe(expected)
    }
  })

  it('never interprets regex metacharacters from the pattern', () => {
    expect(patternMatches('/a.b', '/aXb')).toBe(false)
    expect(patternMatches('/a.b', '/a.b/x')).toBe(true)
    expect(patternMatches('/a+', '/aa')).toBe(false)
    expect(patternMatches('/(a|b)', '/a')).toBe(false)
  })
})

describe('parseRuleSet', () => {
  it('reads groups, globals, ignored and orphan lines', () => {
    const parsed = parseRuleSet(ROBOTS_RULES)
    expect(parsed.groups.length).toBe(4)
    expect(parsed.groups.map((group) => group.agents)).toEqual([['*'], ['dsh-webfetch'], ['dsh-webfetch'], ['googlebot']])
    expect(parsed.groups[0]?.rules.map((rule) => [rule.type, rule.pattern, rule.length, rule.line]))
      .toEqual([['disallow', '/private', 8, 3], ['allow', '/private/public', 15, 4]])
    expect(parsed.groups[1]?.rules.map((rule) => [rule.pattern, rule.length, rule.line]))
      .toEqual([['/no-webfetch', 12, 8], ['/no-webfetch/allowed', 20, 9]])
    expect(parsed.groups[2]?.rules.map((rule) => rule.pattern)).toEqual(['/*.pdf$'])
    expect(parsed.groups[3]?.rules).toEqual([])
    expect(parsed.ignoredRules).toBe(1)
    expect(parsed.orphanRules).toBe(0)
    expect(parsed.crawlDelay).toBe('10')
    expect(parsed.sitemaps).toEqual(['https://example.test/sitemap.xml'])
  })

  it('starts a new group only after rules were seen, and ignores comments', () => {
    const parsed = parseRuleSet('User-agent: a\nUser-agent: b\nDisallow: /x\nUser-agent: c\nDisallow: /y\n')
    expect(parsed.groups.map((group) => group.agents)).toEqual([['a', 'b'], ['c']])
    expect(parsed.groups[0]?.rules.map((rule) => rule.pattern)).toEqual(['/x'])
  })

  it('counts rule lines that appear before any group', () => {
    const parsed = parseRuleSet(ROBOTS_ODD)
    expect(parsed.orphanRules).toBe(1)
    expect(parsed.groups[0]?.rules.map((rule) => rule.length)).toEqual([5, 15])
  })

  it('measures pattern specificity in UTF-8 octets, not characters', () => {
    const parsed = parseRuleSet(ROBOTS_ODD)
    expect(parsed.groups[0]?.rules[1]?.length).toBe(15)
    expect(parsed.groups[0]?.rules[1]?.pattern.length).toBe(8)
  })
})

describe('selectGroups', () => {
  it('prefers the most specific agent and merges same-specificity groups', () => {
    const selection = selectGroups(parseRuleSet(ROBOTS_RULES), 'dsh-webfetch')
    expect(selection.kind).toBe('specific')
    expect(selection.matchedAgents).toEqual(['dsh-webfetch'])
    expect(selection.rules.map((rule) => rule.pattern)).toEqual(['/no-webfetch', '/no-webfetch/allowed', '/*.pdf$'])
  })

  it('falls back to * when nothing matches, and reports no group at all', () => {
    expect(selectGroups(parseRuleSet(ROBOTS_RULES), 'otherbot')).toMatchObject({ kind: 'wildcard', matchedAgents: ['*'] })
    expect(selectGroups(parseRuleSet(ROBOTS_NO_GROUP), 'dsh-webfetch')).toMatchObject({ kind: 'none', matchedAgents: [] })
  })

  it('matches agent values case-insensitively as a prefix of the token', () => {
    const parsed = parseRuleSet('User-agent: DSH-Web\nDisallow: /x\n')
    expect(selectGroups(parsed, 'dsh-webfetch').kind).toBe('specific')
    expect(selectGroups(parsed, 'dshx').kind).toBe('none')
  })
})

describe('evaluateRobots', () => {
  it('names the rule that decided each answer', () => {
    const blocked = evaluateRobots(ROBOTS_RULES, { userAgent: OUR_UA, target: '/no-webfetch/x' })
    expect(blocked.allowed).toBe(false)
    expect(blocked.decision).toBe('rule')
    expect(blocked.rule).toEqual({ type: 'disallow', pattern: '/no-webfetch', length: 12, line: 8 })
    expect(blocked.ruleCount).toBe(3)
    expect(blocked.groupCount).toBe(4)
    expect(blocked.bytes).toBe(326)
    expect(blocked.crawlDelay).toBe('10')
    expect(blocked.notes.some((note) => note.includes('Crawl-delay 10 is published'))).toBe(true)

    const allowed = evaluateRobots(ROBOTS_RULES, { userAgent: OUR_UA, target: '/no-webfetch/allowed/x' })
    expect(allowed.allowed).toBe(true)
    expect(allowed.rule).toMatchObject({ type: 'allow', pattern: '/no-webfetch/allowed', length: 20 })
  })

  it('leaves `rule` absent when nothing matched, instead of inventing one', () => {
    const result = evaluateRobots(ROBOTS_RULES, { userAgent: OUR_UA, target: '/private/page' })
    expect(result.allowed).toBe(true)
    expect(result.decision).toBe('no-matching-rule')
    expect(result.rule).toBeNull()
    expect(result.matchedKind).toBe('specific')
    expect(result.notes.some((note) => note.includes('none match this path'))).toBe(true)
  })

  it('does not consult the * group when a specific group exists', () => {
    const specific = evaluateRobots(ROBOTS_RULES, { userAgent: OUR_UA, target: '/private/page' })
    const wildcard = evaluateRobots(ROBOTS_RULES, { userAgent: OTHER_UA, target: '/private/page' })
    expect(specific.allowed).toBe(true)
    expect(wildcard.allowed).toBe(false)
    expect(wildcard.matchedKind).toBe('wildcard')
    expect(wildcard.rule).toMatchObject({ pattern: '/private', length: 8, line: 3 })
  })

  it('lets the longer rule win and Allow win a tie', () => {
    expect(evaluateRobots(ROBOTS_RULES, { userAgent: OTHER_UA, target: '/private/public/x' }).allowed).toBe(true)
    expect(evaluateRobots(ROBOTS_TIE, { userAgent: OTHER_UA, target: '/deeper/x' }).allowed).toBe(false)
    const tie = evaluateRobots(ROBOTS_TIE, { userAgent: OTHER_UA, target: '/tie' })
    expect(tie.allowed).toBe(true)
    expect(tie.rule).toMatchObject({ type: 'allow', pattern: '/tie', length: 4 })
  })

  it('anchors a trailing $ at the end of the path, so a query is a different resource', () => {
    expect(evaluateRobots(ROBOTS_RULES, { userAgent: OUR_UA, target: '/docs/report.pdf' }).allowed).toBe(false)
    const withQuery = evaluateRobots(ROBOTS_RULES, { userAgent: OUR_UA, target: '/docs/report.pdf?x=1' })
    expect(withQuery.allowed).toBe(true)
    expect(withQuery.decision).toBe('no-matching-rule')
  })

  it('reports an empty user-agent group as "no rules of ours"', () => {
    const result = evaluateRobots(ROBOTS_RULES, { userAgent: 'googlebot/2.1', target: '/no-webfetch/x' })
    expect(result.allowed).toBe(true)
    expect(result.decision).toBe('no-matching-rule')
    expect(result.ruleCount).toBe(0)
    expect(result.matchedAgents).toEqual(['googlebot'])
  })

  it('explains a bare pattern that can never match a path', () => {
    const result = evaluateRobots(ROBOTS_ODD, { userAgent: OTHER_UA, target: '/admin' })
    expect(result.allowed).toBe(true)
    expect(result.orphanRules).toBe(1)
    const note = result.notes.find((entry) => entry.includes('do not start with')) ?? ''
    expect(note).toContain('"admin"')
    expect(note).not.toContain('/admin')
    expect(evaluateRobots(ROBOTS_ODD, { userAgent: OTHER_UA, target: '/заметки/x' }).rule).toMatchObject({ length: 15 })
  })

  it('allows everything for an empty document, and says so', () => {
    const result = evaluateRobots('', { userAgent: OUR_UA, target: '/' })
    expect(result.allowed).toBe(true)
    expect(result.decision).toBe('no-group')
    expect(result.bytes).toBe(0)
    expect(result.notes.some((note) => note.includes('empty'))).toBe(true)
  })

  it('caps the listed rules while keeping the real counts', () => {
    const result = evaluateRobots(ROBOTS_RULES, { userAgent: OUR_UA, target: '/x', maxRules: 1 })
    expect(result.rules.length).toBe(1)
    expect(result.ruleCount).toBe(3)
    expect(evaluateRobots(ROBOTS_RULES, { userAgent: OUR_UA, target: '/x', maxRules: 9_999 }).rules.length).toBe(3)
  })

  it('keeps the documented bounds', () => {
    expect(DEFAULT_MAX_RULES).toBe(50)
    expect(MAX_RULES_LIMIT).toBe(200)
    expect(ROBOTS_SIZE_LIMIT).toBe(512_000)
  })

  it('warns when a file is over the RFC size limit, or publishes a crawl delay', () => {
    const big = `User-agent: *\nDisallow: /x\n# ${'a'.repeat(ROBOTS_SIZE_LIMIT)}\n`
    const result = evaluateRobots(big, { userAgent: OTHER_UA, target: '/y' })
    expect(result.notes.some((note) => note.includes('512000-byte limit'))).toBe(true)
  })
})

describe('web_robots end-to-end (fixture servers)', () => {
  let server: Server
  let missing: Server
  let broken: Server
  let base = ''
  let missingBase = ''
  let brokenBase = ''

  const run = (args: RobotsArgs): Promise<RobotsResult> => {
    const tools = buildWebfetchTools(resolveConfig({}, {}))
    return (tools.web_robots.execute as (input: RobotsArgs) => Promise<RobotsResult>)(args)
  }

  const listen = (handler: Parameters<typeof createServer>[0]): Promise<Server> => new Promise((done) => {
    const created = createServer(handler)
    created.listen(0, '127.0.0.1', () => done(created))
  })

  beforeAll(async () => {
    server = await listen((request, response) => {
      if (request.url === '/robots.txt') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(ROBOTS_RULES)
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><body>page</body></html>')
    })
    missing = await listen((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    })
    broken = await listen((_request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.end('service unavailable')
    })
    const address = server.address()
    const missingAddress = missing.address()
    const brokenAddress = broken.address()
    if (typeof address === 'object' && address !== null) base = `http://127.0.0.1:${address.port}`
    if (typeof missingAddress === 'object' && missingAddress !== null) missingBase = `http://127.0.0.1:${missingAddress.port}`
    if (typeof brokenAddress === 'object' && brokenAddress !== null) brokenBase = `http://127.0.0.1:${brokenAddress.port}`
  })

  afterAll(() => {
    server.close()
    missing.close()
    broken.close()
  })

  it('checks a page path against the fetched robots.txt', async () => {
    const result = await run({ url: `${base}/no-webfetch/x` })
    assertLossless(result)
    expect(result.robotsUrl).toBe(`${base}/robots.txt`)
    expect(result.robotsStatus).toBe(200)
    expect(result.bytes).toBe(326)
    expect(result.target).toBe('/no-webfetch/x')
    expect(result.productToken).toBe('dsh-webfetch')
    expect(result.allowed).toBe(false)
    expect(result.rule).toMatchObject({ type: 'disallow', pattern: '/no-webfetch', line: 8 })
    expect(result.crawlDelay).toBe('10')
    expect(result.sitemaps).toEqual(['https://example.test/sitemap.xml'])
    expect(result.truncated).toBe(false)
  })

  it('accepts an explicit path and user agent', async () => {
    const result = await run({ url: `${base}/robots.txt`, path: '/private/public/x', userAgent: OTHER_UA })
    expect(result.target).toBe('/private/public/x')
    expect(result.allowed).toBe(true)
    expect(result.matchedKind).toBe('wildcard')
    expect(result.rule).toMatchObject({ pattern: '/private/public', length: 15 })
  })

  it('adds a leading slash to a bare path', async () => {
    const result = await run({ url: `${base}/index.html`, path: 'private/page', userAgent: OTHER_UA })
    expect(result.target).toBe('/private/page')
    expect(result.allowed).toBe(false)
    expect(result.robotsUrl).toBe(`${base}/robots.txt`)
  })

  it('treats a 4xx robots.txt as "no rules"', async () => {
    const result = await run({ url: `${missingBase}/anything` })
    expect(result.robotsStatus).toBe(404)
    expect(result.allowed).toBe(true)
    expect(result.decision).toBe('no-robots')
    expect(result.bytes).toBe(0)
    expect(result.notes.some((note) => note.includes('4xx'))).toBe(true)
  })

  it('treats a 5xx robots.txt as "assume disallowed"', async () => {
    const result = await run({ url: `${brokenBase}/anything` })
    expect(result.robotsStatus).toBe(503)
    expect(result.allowed).toBe(false)
    expect(result.decision).toBe('unavailable')
    expect(result.notes.some((note) => note.includes('assume complete disallow'))).toBe(true)
  })

  it('rejects non-http URLs before fetching anything', async () => {
    await expect(run({ url: 'file:///etc/hosts' })).rejects.toThrow(/only http and https/)
  })

  it('renders the decision, the rule and the notes', async () => {
    const tools = buildWebfetchTools(resolveConfig({}, {}))
    const definition = tools.web_robots
    const result = await run({ url: `${base}/no-webfetch/x` })
    const rendered = definition.output.render?.({ url: `${base}/no-webfetch/x` }, result)
    const text = rendered?.[0]?.text ?? ''
    expect(text).toContain('disallowed by disallow "/no-webfetch"')
    expect(text).toContain('token "dsh-webfetch"')
    expect(text).toContain('crawl-delay 10')
  })

  it('renders a default-allow answer without naming a rule', async () => {
    const tools = buildWebfetchTools(resolveConfig({}, {}))
    const result = await run({ url: `${base}/no-webfetch/x`, path: '/other' })
    expect('rule' in result).toBe(false)
    expect(result.decision).toBe('no-matching-rule')
    const text = tools.web_robots.output.render?.({ url: `${base}/no-webfetch/x` }, result)?.[0]?.text ?? ''
    expect(text).toContain('allowed — nothing matched')
    expect(text).not.toContain('disallowed by')
  })
})
