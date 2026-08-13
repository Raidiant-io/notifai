/**
 * Version arithmetic for the published packages.
 *
 * SemVer 2.0.0 §4: 0.y.z is initial development and anything MAY change.
 * npm caret ranges still treat the left-most non-zero digit as the
 * compatibility line, so ^0.5.1 is >=0.5.1 <0.6.0-0. The house rule
 * honours that:
 *
 *   0.y.z  breaking → minor,  feat|fix → patch
 *   1.y.z+ breaking → major,  feat → minor,  fix → patch
 *
 * Other types do not bump unless they are marked breaking.
 */

const STRICT = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }}
 */
export function parseVersion(version) {
  const match = STRICT.exec(version)
  if (!match) {
    throw new Error(`version is not a strict major.minor.patch: ${JSON.stringify(version)}`)
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * @param {{ major: number, minor: number, patch: number }} parsed
 */
export function formatVersion(parsed) {
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`
}

/**
 * @param {string} version
 * @param {'major' | 'minor' | 'patch'} kind
 */
export function bumpVersion(version, kind) {
  const parsed = parseVersion(version)
  if (kind === 'major') return formatVersion({ major: parsed.major + 1, minor: 0, patch: 0 })
  if (kind === 'minor') return formatVersion({ major: parsed.major, minor: parsed.minor + 1, patch: 0 })
  if (kind === 'patch') return formatVersion({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1 })
  throw new Error(`unknown bump kind: ${kind}`)
}

/**
 * @param {Iterable<{ type: string, breaking: boolean }>} commits
 * @param {string} currentVersion
 * @returns {'major' | 'minor' | 'patch' | null}
 */
export function bumpFromCommits(commits, currentVersion) {
  const { major } = parseVersion(currentVersion)
  const preRelease = major === 0
  let breaking = false
  let feat = false
  let fix = false
  for (const commit of commits) {
    if (commit.breaking) breaking = true
    if (commit.type === 'feat') feat = true
    if (commit.type === 'fix') fix = true
  }
  if (preRelease) {
    if (breaking) return 'minor'
    if (feat || fix) return 'patch'
    return null
  }
  if (breaking) return 'major'
  if (feat) return 'minor'
  if (fix) return 'patch'
  return null
}
