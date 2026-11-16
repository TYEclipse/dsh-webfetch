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
export declare const DEFAULT_MAX_RULES = 50;
/** Hard upper bound for maxRules. */
export declare const MAX_RULES_LIMIT = 200;
/** Size limit for a robots.txt file (RFC 9309 §2.5); larger files may be cut. */
export declare const ROBOTS_SIZE_LIMIT = 512000;
/** Per-pattern cap, so one absurd line cannot dominate the output. */
export declare const MAX_PATTERN_CHARS = 2000;
/** `allow` or `disallow`, as written in the file. */
export type RuleType = 'allow' | 'disallow';
/** One parsed rule of a group. `length` is the pattern length in octets. */
export interface RobotsRule {
    type: RuleType;
    pattern: string;
    length: number;
    /** 1-based line number the rule was read from. */
    line: number;
}
/** One `User-agent` group: its agents (verbatim) and its rules. */
export interface RobotsGroup {
    agents: string[];
    rules: RobotsRule[];
}
/** Result of parsing a robots.txt document into groups and globals. */
export interface ParsedRuleSet {
    groups: RobotsGroup[];
    sitemaps: string[];
    crawlDelay: string;
    /** `Allow`/`Disallow` lines that appeared before any `User-agent`. */
    orphanRules: number;
    /** `Allow`/`Disallow` lines with an empty value (they match nothing). */
    ignoredRules: number;
}
/** The group selection for one product token. */
export interface GroupSelection {
    kind: 'specific' | 'wildcard' | 'none';
    /** User-agent values that selected the group(s), in document order. */
    matchedAgents: string[];
    rules: RobotsRule[];
}
/** The rule that decided an evaluation (absent when nothing matched). */
export interface RuleDecision {
    type: RuleType;
    pattern: string;
    length: number;
    line: number;
}
/** Full evaluation of one path against one robots.txt document. */
export interface RobotsEvaluation {
    allowed: boolean;
    decision: 'rule' | 'no-matching-rule' | 'no-group';
    matchedKind: 'specific' | 'wildcard' | 'none';
    matchedAgents: string[];
    rule: RuleDecision | null;
    rules: RobotsRule[];
    groupCount: number;
    ruleCount: number;
    ignoredRules: number;
    orphanRules: number;
    crawlDelay: string;
    sitemaps: string[];
    bytes: number;
    notes: string[];
}
/** Options for {@link evaluateRobots}. */
export interface EvaluateOptions {
    /** User agent string; the product token before `/` and space is matched. */
    userAgent: string;
    /** Encoded path plus optional `?query` to test. */
    target: string;
    /** Max rules listed for the selected group (default 50, max 200). */
    maxRules?: number;
}
/**
 * Extract the product token from a user agent string: the first
 * whitespace-delimited word, without a `/version` suffix or a trailing
 * comment. `dsh-webfetch/0.7 (DeepSeek Harness plugin)` → `dsh-webfetch`.
 */
export declare function productToken(userAgent: string): string;
/**
 * Parse a robots.txt document into user-agent groups plus the global
 * `Sitemap:` / `Crawl-delay:` values. Comments (`#…`) are stripped, keys are
 * case-insensitive, and unknown keys are ignored (RFC 9309 §2.2.4 allows
 * extensions; we keep only what we can honour).
 */
export declare function parseRuleSet(text: string): ParsedRuleSet;
/**
 * Select the group(s) that apply to a product token: the most specific
 * user-agent match wins, several groups with the same specificity are merged
 * in document order, and `*` is only used when nothing specific matches.
 */
export declare function selectGroups(parsed: ParsedRuleSet, token: string): GroupSelection;
/**
 * Does one robots.txt pattern match a target path? Patterns are anchored at
 * the start of the string, `*` matches any sequence, and a trailing `$`
 * anchors the end (RFC 9309 §2.2.2). Implemented by splitting on `*` and
 * walking the parts — no regex, so nothing in the pattern is ever interpreted
 * as a regex metacharacter.
 */
export declare function patternMatches(pattern: string, target: string): boolean;
/**
 * Evaluate one path against one robots.txt document. The decision names how
 * it was reached (`rule` / `no-matching-rule` / `no-group`) and `rule` is
 * **null** when no rule decided it — the honest answer is "nothing matched",
 * not a made-up pattern.
 */
export declare function evaluateRobots(text: string, options: EvaluateOptions): RobotsEvaluation;
//# sourceMappingURL=robots.d.ts.map