/**
 * Canonical "lossless JSON" guard for plugin test suites (dsh-autopilot R66).
 *
 * dsh validates every tool result and every tool argument tree by round-tripping
 * it through JSON before the result reaches the agent. Two things survive a
 * naive `JSON.stringify` but not the strict comparison on the way back:
 *
 *   1. `undefined` values on live keys        → `{"a": undefined}` becomes `{}`
 *      (R7/R18: the original "not lossless JSON" failure).
 *   2. `-0`                                   → stringifies as `"0"`, and a
 *      strict deep-equality check (`Object.is`) sees `0 !== -0` (R66). Any
 *      computation that rounds a tiny negative channel — `Math.round(-4e-5 *
 *      1e4) / 1e4` is literally `-0` — can produce it without anyone noticing:
 *      it only fails in production, never in the tests that only ever used
 *      positive numbers.
 *
 * Copy this file into a plugin's `test/` directory and call `assertLossless()`
 * on every tool result (and, where a tool validates arguments itself, on the
 * argument object too). dsh-autopilot's `tools/new-plugin.sh` installs it
 * automatically for new plugins, and `tests/test_docs.py` guards the template.
 */

/** Throw if any key anywhere in the tree holds `undefined`. */
export function assertNoUndefined(value: unknown, path = 'root'): void {
  if (value === undefined) throw new Error(`undefined value at ${path}`)
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoUndefined(item, `${path}[${i}]`))
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertNoUndefined(child, `${path}.${key}`)
  }
}

/**
 * Throw if any number that cannot survive a JSON round-trip appears: `-0`
 * (stringifies to `"0"`), plus `NaN`/`±Infinity` (stringify to `null`).
 * Round your outputs (e.g. `roundOut()` in the plugin, which folds `-0` into
 * `0`) rather than loosening this guard.
 */
export function assertLosslessNumbers(value: unknown, path = 'root'): void {
  if (typeof value === 'number') {
    if (Object.is(value, -0)) throw new Error(`negative zero at ${path}`)
    if (!Number.isFinite(value)) throw new Error(`non-finite number (${value}) at ${path}`)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertLosslessNumbers(item, `${path}[${i}]`))
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertLosslessNumbers(child, `${path}.${key}`)
  }
}

/** Both guards in one call — what every tool-result test should use. */
export function assertLossless(value: unknown, path = 'root'): void {
  assertNoUndefined(value, path)
  assertLosslessNumbers(value, path)
}
