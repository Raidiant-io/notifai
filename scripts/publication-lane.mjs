/** Package versions encode the release audience; Git tags mirror them exactly. */
import { compareReleasePrecedence, isPrerelease, isSemVer } from '../apps/cli/src/version.js'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/

export function publicationLane(version) {
  const match = VERSION.exec(version)
  if (match === null) {
    throw new Error(`unsupported release version ${version}; use X.Y.Z or X.Y.Z-beta.N`)
  }
  return match[4] === undefined ? 'latest' : 'beta'
}

export function requireBetaAheadOfLatest(version, latest) {
  if (publicationLane(version) !== 'beta') return
  const candidate = VERSION.exec(version)
  const stable = VERSION.exec(latest)
  if (stable === null || stable[4] !== undefined) {
    throw new Error(`npm latest must be a stable release before publishing ${version}`)
  }
  for (let index = 1; index <= 3; index += 1) {
    const a = BigInt(candidate[index])
    const b = BigInt(stable[index])
    if (a > b) return
    if (a < b) break
  }
  throw new Error(`${version} must target a version newer than npm latest ${latest}`)
}

/** CLI beta may be absent (falls back to latest), but never a stable version:
 * older installed CLIs reject that entire npm discovery document. */
export function requireCurrentNpmChannels(name, tags) {
  if (tags.latest !== undefined && (!isSemVer(tags.latest) || isPrerelease(tags.latest))) {
    throw new Error(`${name}: npm latest must be stable`)
  }
  if (tags.beta !== undefined) {
    if (!isSemVer(tags.beta) || (name === '@raidiant/notifai' && !isPrerelease(tags.beta))) {
      throw new Error(`${name}: npm CLI beta must remain prerelease-only for existing clients`)
    }
    if (tags.latest !== undefined && compareReleasePrecedence(tags.beta, tags.latest) === 'before') {
      throw new Error(`${name}: npm beta is behind latest`)
    }
  } else if (name !== '@raidiant/notifai' && tags.latest !== undefined) {
    throw new Error(`${name}: npm beta is missing`)
  }
}

/** Ordered writes keep beta current before latest advances. npm has no
 * multi-tag CAS; the protected workflow serializes all package publishers. */
export function npmPromotion({ name, version, before }) {
  const lane = publicationLane(version)
  for (const tag of ['latest', 'beta']) {
    if (before[tag] !== undefined && !isSemVer(before[tag])) throw new Error(`Malformed npm ${tag}`)
  }
  if (before.latest !== undefined && isPrerelease(before.latest)) throw new Error('npm latest must be stable')
  if (name === '@raidiant/notifai' && before.beta !== undefined && !isPrerelease(before.beta)) {
    throw new Error('npm CLI beta must remain prerelease-only for existing clients')
  }
  if (before[lane] !== undefined && compareReleasePrecedence(version, before[lane]) === 'before') {
    throw new Error(`Refusing to roll back npm ${lane}`)
  }
  if (lane === 'beta') {
    if (before.latest !== undefined) requireBetaAheadOfLatest(version, before.latest)
    return before.beta === version ? [] : [{ tag: 'beta', version }]
  }
  const writes = []
  if (before.beta === undefined || compareReleasePrecedence(before.beta, version) === 'before') {
    if (name === '@raidiant/notifai') {
      if (before.beta !== undefined) writes.push({ tag: 'beta', version: null })
    } else writes.push({ tag: 'beta', version })
  }
  if (before.latest !== version) writes.push({ tag: 'latest', version })
  return writes
}

export function requireMatchingReleaseLane(packages, trigger) {
  const lane = publicationLane(trigger.version)
  for (const entry of packages) {
    const entryLane = publicationLane(entry.version)
    if (entry.name !== trigger.name && entryLane !== lane && entry.taggedHere) {
      throw new Error(`cannot publish a ${entryLane} package from a ${lane} release tag`)
    }
  }
  return lane
}
