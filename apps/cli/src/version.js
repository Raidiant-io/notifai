const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const ORDERED_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

/** @typedef {'before' | 'equal' | 'after' | 'unparseable'} VersionComparison */

/**
 * The numeric release identity shared by CLI, harness, and runtime checks.
 * Pre-release/build suffixes identify artifacts but do not change capability
 * floors, matching the version comparisons these callers previously owned.
 *
 * @param {string} value
 * @returns {readonly [number, number, number] | null}
 */
export function parseVersion(value) {
  const match = ORDERED_VERSION.exec(value)
  if (match === null) return null
  const parsed = /** @type {readonly [number, number, number]} */ ([
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ])
  return parsed.every(Number.isSafeInteger) ? parsed : null
}

/**
 * Compare two release identities without silently treating malformed input as
 * zero. Every caller must choose its own safe posture for `unparseable`.
 *
 * @param {string} left
 * @param {string} right
 * @returns {VersionComparison}
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 'unparseable'
  for (let index = 0; index < a.length; index += 1) {
    const leftPart = a[index]
    const rightPart = b[index]
    if (leftPart === undefined || rightPart === undefined) return 'unparseable'
    if (leftPart === rightPart) continue
    return leftPart < rightPart ? 'before' : 'after'
  }
  return 'equal'
}

/** @param {string} value */
export function isSemVer(value) {
  return SEMVER.test(value)
}
