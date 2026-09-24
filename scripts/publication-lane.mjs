/** Package versions encode the release audience; Git tags mirror them exactly. */
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
