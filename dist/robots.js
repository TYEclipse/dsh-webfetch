/**
 * Dependency-free robots.txt rule engine for dsh-webfetch.
 *
 * `web_sitemap` only reads the `Sitemap:` directives of robots.txt; this
 * module reads the actual access rules and answers the question a crawler
 * asks first: *may this agent read this path?* The rules follow RFC 9309
 * (the Robots Exclusion Protocol) plus the behaviour Google publishes:
 *
 *   - Groups are `User-agent:` lines followed by `Allow:`/`Disallow:` lines.
 *     A `User-agent:` line after a rule starts a new group; `Sitemap:` and
 *     `Crawl-delay:` are global and do not end a group.
 *   - A group matches when its user-agent value is a case-insensitive prefix
 *     of our product token; the most specific (longest) match wins. Groups
 *     without a specific match fall back to `*`.
 *   - Rules match the encoded path + query from the start of the string;
 *     `*` matches any sequence of characters, a trailing `$` anchors the end.
 *   - The longest matching rule wins, and `Allow` wins a tie (§2.2.2).
 *   - No matching rule means allowed; a 4xx robots.txt means allowed; a 5xx
 *     robots.txt means "assume complete disallow" (§2.3.1) — the tool layer
 *     reports which of those happened instead of guessing.
 *
 * Nothing here executes or evaluates content from the document, and every
 * limit is bounded so a hostile robots.txt cannot bloat a result.
 *
 * @module dsh-webfetch/robots
 */
/** Default number of rules listed for the selected group. */
export const DEFAULT_MAX_RULES = 50;
/** Hard upper bound for maxRules. */
export const MAX_RULES_LIMIT = 200;
/** Size limit for a robots.txt file (RFC 9309 §2.5); larger files may be cut. */
export const ROBOTS_SIZE_LIMIT = 512_000;
/** Per-pattern cap, so one absurd line cannot dominate the output. */
export const MAX_PATTERN_CHARS = 2_000;
/** Octet length of a string (RFC 9309 compares pattern specificity in octets). */
function octets(value) {
    return Buffer.byteLength(value, 'utf8');
}
/** Collapse the whitespace of a directive value and cap its length. */
function cleanValue(value) {
    const collapsed = value.replace(/\s+/g, ' ').trim();
    return collapsed.length <= MAX_PATTERN_CHARS ? collapsed : collapsed.slice(0, MAX_PATTERN_CHARS);
}
/**
 * Extract the product token from a user agent string: the first
 * whitespace-delimited word, without a `/version` suffix or a trailing
 * comment. `dsh-webfetch/0.7 (DeepSeek Harness plugin)` → `dsh-webfetch`.
 */
export function productToken(userAgent) {
    const first = userAgent.trim().split(/[\s()]/)[0] ?? '';
    const slash = first.indexOf('/');
    return (slash < 0 ? first : first.slice(0, slash)).toLowerCase();
}
/**
 * Parse a robots.txt document into user-agent groups plus the global
 * `Sitemap:` / `Crawl-delay:` values. Comments (`#…`) are stripped, keys are
 * case-insensitive, and unknown keys are ignored (RFC 9309 §2.2.4 allows
 * extensions; we keep only what we can honour).
 */
export function parseRuleSet(text) {
    const groups = [];
    const sitemaps = [];
    const seenSitemaps = new Set();
    let crawlDelay = '';
    let current = null;
    let orphanRules = 0;
    let ignoredRules = 0;
    let lineNumber = 0;
    for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
        lineNumber += 1;
        const line = (rawLine.split('#')[0] ?? '').trim();
        if (line === '')
            continue;
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = cleanValue(line.slice(colon + 1));
        if (key === 'user-agent') {
            if (value === '')
                continue;
            // A user-agent line after rules starts a new group; consecutive
            // user-agent lines share one group (RFC 9309 §2.1).
            if (current === null || current.rules.length > 0) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value);
            continue;
        }
        if (key === 'allow' || key === 'disallow') {
            if (current === null) {
                orphanRules += 1;
                continue;
            }
            if (value === '') {
                // An empty Disallow conventionally means "nothing is disallowed";
                // an empty Allow can never match either. Neither is a rule.
                ignoredRules += 1;
                continue;
            }
            current.rules.push({ type: key, pattern: value, length: octets(value), line: lineNumber });
            continue;
        }
        if (key === 'sitemap' && value !== '') {
            if (!seenSitemaps.has(value)) {
                seenSitemaps.add(value);
                sitemaps.push(value);
            }
            continue;
        }
        if (key === 'crawl-delay' && crawlDelay === '') {
            crawlDelay = value.slice(0, 20);
        }
    }
    return { groups, sitemaps, crawlDelay, orphanRules, ignoredRules };
}
/** Specificity of one agent value against a product token (-1 = no match). */
function agentScore(agent, token) {
    if (agent === '*')
        return -1;
    const lowered = agent.toLowerCase();
    return token.startsWith(lowered) ? octets(lowered) : -1;
}
/**
 * Select the group(s) that apply to a product token: the most specific
 * user-agent match wins, several groups with the same specificity are merged
 * in document order, and `*` is only used when nothing specific matches.
 */
export function selectGroups(parsed, token) {
    const scored = parsed.groups.map((group) => {
        let best = -1;
        for (const agent of group.agents) {
            const score = agentScore(agent, token);
            if (score > best)
                best = score;
        }
        return { group, score: best };
    });
    const specific = scored.filter((entry) => entry.score >= 0);
    if (specific.length > 0) {
        const best = Math.max(...specific.map((entry) => entry.score));
        const winners = specific.filter((entry) => entry.score === best);
        const matchedAgents = [];
        const rules = [];
        for (const { group } of winners) {
            for (const agent of group.agents) {
                const isWildcard = agent === '*';
                if (!isWildcard && matchedAgents.includes(agent) === false)
                    matchedAgents.push(agent);
            }
            rules.push(...group.rules);
        }
        return { kind: 'specific', matchedAgents, rules };
    }
    const wildcard = scored.filter(({ group }) => group.agents.includes('*'));
    if (wildcard.length > 0) {
        const matchedAgents = ['*'];
        const rules = [];
        for (const { group } of wildcard) {
            for (const agent of group.agents) {
                if (agent !== '*' && matchedAgents.includes(agent) === false)
                    matchedAgents.push(agent);
            }
            rules.push(...group.rules);
        }
        return { kind: 'wildcard', matchedAgents, rules };
    }
    return { kind: 'none', matchedAgents: [], rules: [] };
}
/**
 * Does one robots.txt pattern match a target path? Patterns are anchored at
 * the start of the string, `*` matches any sequence, and a trailing `$`
 * anchors the end (RFC 9309 §2.2.2). Implemented by splitting on `*` and
 * walking the parts — no regex, so nothing in the pattern is ever interpreted
 * as a regex metacharacter.
 */
export function patternMatches(pattern, target) {
    let body = pattern;
    let anchored = false;
    if (body.endsWith('$')) {
        anchored = true;
        body = body.slice(0, -1);
    }
    const parts = body.split('*');
    const first = parts[0] ?? '';
    if (target.startsWith(first) === false)
        return false;
    let position = first.length;
    for (let index = 1; index < parts.length; index += 1) {
        const part = parts[index] ?? '';
        const isLast = index === parts.length - 1;
        if (part === '') {
            if (isLast)
                return true;
            continue;
        }
        const found = target.indexOf(part, position);
        if (found < 0)
            return false;
        if (isLast && anchored === false)
            return true;
        position = found + part.length;
    }
    return anchored ? position === target.length : true;
}
/**
 * Evaluate one path against one robots.txt document. The decision names how
 * it was reached (`rule` / `no-matching-rule` / `no-group`) and `rule` is
 * **null** when no rule decided it — the honest answer is "nothing matched",
 * not a made-up pattern.
 */
export function evaluateRobots(text, options) {
    const token = productToken(options.userAgent);
    const parsed = parseRuleSet(text);
    const selection = selectGroups(parsed, token);
    const maxRules = Math.min(Math.max(options.maxRules ?? DEFAULT_MAX_RULES, 1), MAX_RULES_LIMIT);
    const notes = [];
    const bytes = octets(text);
    const matching = selection.rules.filter((rule) => patternMatches(rule.pattern, options.target));
    const sorted = [...matching].sort((left, right) => {
        if (right.length !== left.length)
            return right.length - left.length;
        // Tie on specificity: Allow wins (RFC 9309 §2.2.2).
        if (left.type !== right.type)
            return left.type === 'allow' ? -1 : 1;
        return left.line - right.line;
    });
    const winner = sorted[0] ?? null;
    if (selection.kind === 'none') {
        notes.push(`no group matches "${token}" and the file has no \`*\` group — RFC 9309 §2.2.2 lets a crawler read everything`);
    }
    else if (winner === null) {
        notes.push(`the ${selection.kind === 'wildcard' ? '`*`' : `"${selection.matchedAgents.join('", "')}"`} group has ${selection.rules.length} rule(s) but none match this path — allowed by default`);
    }
    const oddPatterns = selection.rules.filter((rule) => rule.pattern.startsWith('/') === false && rule.pattern.startsWith('*') === false);
    if (oddPatterns.length > 0) {
        const example = oddPatterns[0]?.pattern ?? '';
        notes.push(`${oddPatterns.length} rule pattern(s) do not start with "/" or "*" (e.g. "${example}") — rules match the path from its first character, so a pattern without a leading "/" can never match one`);
    }
    if (parsed.ignoredRules > 0) {
        notes.push(`${parsed.ignoredRules} empty Allow/Disallow line(s) ignored — an empty pattern matches nothing`);
    }
    if (parsed.orphanRules > 0) {
        notes.push(`${parsed.orphanRules} rule line(s) appeared before any User-agent and were ignored`);
    }
    if (parsed.crawlDelay !== '') {
        notes.push(`Crawl-delay ${parsed.crawlDelay} is published, but RFC 9309 defines no delay directive — it is advisory only`);
    }
    if (bytes > ROBOTS_SIZE_LIMIT) {
        notes.push(`the file is ${bytes} bytes, over the ${ROBOTS_SIZE_LIMIT}-byte limit in RFC 9309 §2.5 — parsers may ignore everything past it`);
    }
    if (text.trim() === '') {
        notes.push('the document is empty — no rules, so everything is allowed');
    }
    return {
        allowed: winner === null ? true : winner.type === 'allow',
        decision: winner === null ? (selection.kind === 'none' ? 'no-group' : 'no-matching-rule') : 'rule',
        matchedKind: selection.kind,
        matchedAgents: selection.matchedAgents,
        rule: winner === null ? null : { type: winner.type, pattern: winner.pattern, length: winner.length, line: winner.line },
        rules: selection.rules.slice(0, maxRules),
        groupCount: parsed.groups.length,
        ruleCount: selection.rules.length,
        ignoredRules: parsed.ignoredRules,
        orphanRules: parsed.orphanRules,
        crawlDelay: parsed.crawlDelay,
        sitemaps: parsed.sitemaps,
        bytes,
        notes,
    };
}
//# sourceMappingURL=robots.js.map