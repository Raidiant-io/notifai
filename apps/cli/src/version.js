const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const NUMERIC_IDENTIFIER = /^\d+$/
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

/**
 * Order digit strings without leading zeros (SemVer forbids them), so values
 * beyond Number.MAX_SAFE_INTEGER still compare exactly.
 *
 * @param {string} left
 * @param {string} right
 * @returns {-1 | 0 | 1}
 */
function compareDigits(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * SemVer 2.0.0 section 11: numeric identifiers compare numerically and rank
 * below alphanumeric ones; a longer list wins when every shared field is equal.
 *
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 * @returns {-1 | 0 | 1}
 */
function comparePrerelease(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = NUMERIC_IDENTIFIER.test(a)
    const bNumeric = NUMERIC_IDENTIFIER.test(b)
    const order = aNumeric && bNumeric
      ? compareDigits(a, b)
      : aNumeric !== bNumeric
        ? (aNumeric ? -1 : 1)
        : a === b ? 0 : a < b ? -1 : 1
    if (order !== 0) return order
  }
  return 0
}

/**
 * Order two published releases by full SemVer 2.0.0 precedence: a prerelease
 * sorts before its stable release (`1.0.0-beta.2` < `1.0.0`), and build
 * metadata is ignored. Use this for release ordering only; capability floors
 * keep `compareVersions`. Anything that is not strict SemVer is `unparseable`
 * and the caller chooses its safe posture.
 *
 * @param {string} left
 * @param {string} right
 * @returns {VersionComparison}
 */
export function compareReleasePrecedence(left, right) {
  const a = SEMVER.exec(left)
  const b = SEMVER.exec(right)
  if (a === null || b === null) return 'unparseable'
  for (let index = 1; index <= 3; index += 1) {
    const order = compareDigits(/** @type {string} */ (a[index]), /** @type {string} */ (b[index]))
    if (order !== 0) return order < 0 ? 'before' : 'after'
  }
  const aPrerelease = a[4]
  const bPrerelease = b[4]
  if (aPrerelease === undefined || bPrerelease === undefined) {
    if (aPrerelease === bPrerelease) return 'equal'
    return aPrerelease === undefined ? 'after' : 'before'
  }
  const order = comparePrerelease(aPrerelease.split('.'), bPrerelease.split('.'))
  return order === 0 ? 'equal' : order < 0 ? 'before' : 'after'
}

/**
 * Whether a strict SemVer release carries a prerelease, such as a beta.
 *
 * @param {string} value
 */
export function isPrerelease(value) {
  return SEMVER.exec(value)?.[4] !== undefined
}
