// Publish only a complete admitted bundle into its pre-existing release draft.
// Channels advance separately, after immutable release readback.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { RELEASE_TARGETS } from '../apps/cli/dist/release-distribution.js'
import { publicationLane } from './publication-lane.mjs'
import { bootstrapInventoryText } from './generate-bootstrap-metadata.mjs'
import { checkPublicProviderPosture, resolveTagCommit } from './check-public-provider-posture.mjs'

const API = 'https://api.github.com/repos/Raidiant-io/notifai'
const UPLOADS = 'https://uploads.github.com/repos/Raidiant-io/notifai'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const positiveId = value => Number.isSafeInteger(value) && value > 0
export function nativeReleaseBundle(directory, distribution, sourceRevision) {
  const stat = lstatSync(directory)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Release bundle must be a regular directory')
  const read = (name, limit) => {
    const file = path.join(directory, name), stat = lstatSync(file)
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'Release asset must be a bounded regular file')
    return readFileSync(file)
  }
  const bytes = read('inventory.json', 256 * 1024), signedInventory = bytes.toString('utf8')
  const inventory = distribution.verifyInventory(signedInventory)
  assert.equal(inventory.source_revision, sourceRevision, 'Signed inventory source differs')
  assert.deepEqual(inventory.artifacts.map(item => item.target).sort(), [...RELEASE_TARGETS].sort(), 'Incomplete native target set')
  const bootstrap = read('bootstrap.tsv', 256 * 1024)
  assert.equal(bootstrap.toString('utf8'), bootstrapInventoryText(distribution, signedInventory), 'Bootstrap view differs from signed inventory')
  // Bounded artifacts remain on disk; each is reread and authenticated directly
  // before upload. Do not hold all six native archives in memory simultaneously.
  const assets = new Map([['inventory.json', { bytes: bytes.length, sha256: hash(bytes), read: () => bytes }],
    ['bootstrap.tsv', { bytes: bootstrap.length, sha256: hash(bootstrap), read: () => bootstrap }]])
  for (const artifact of inventory.artifacts) {
    const contents = read(artifact.filename, 256 * 1024 * 1024)
    distribution.verifyArtifact(artifact, contents)
    assets.set(artifact.filename, { bytes: artifact.bytes, sha256: artifact.sha256, read: () => {
      const bytes = read(artifact.filename, 256 * 1024 * 1024)
      distribution.verifyArtifact(artifact, bytes)
      return bytes
    } })
  }
  return { inventory, signedInventory, assets }
}

export function nativeGithubClient(token, fetchImpl = fetch) {
  assert.ok(token, 'Protected GitHub publication credential is unavailable')
  return async (endpoint, { method = 'GET', body, raw = false, upload = false, graphql = false, missing = false } = {}) => {
    assert.ok(!(upload && graphql), 'Conflicting GitHub request types')
    const url = graphql ? 'https://api.github.com/graphql' : `${upload ? UPLOADS : API}${endpoint}`
    const response = await fetchImpl(url, { method, redirect: 'error',
      signal: AbortSignal.timeout(raw ? 180_000 : 30_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'User-Agent': 'notifai-native-release', 'X-GitHub-Api-Version': '2026-03-10', 'Cache-Control': 'no-cache',
        ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    })
    if (missing && response.status === 404) return null
    assert.ok(response.ok, `GitHub ${method} publication request returned HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
}

function identity(release, tag, prerelease) {
  assert.ok(positiveId(release?.id) && release.tag_name === tag && release.prerelease === prerelease,
    'GitHub release identity differs from admitted native release')
  assert.ok(release.draft === true || (release.draft === false && release.immutable === true),
    'An existing published release must already be immutable')
  assert.ok(Array.isArray(release.assets), 'GitHub release asset list is unavailable')
}
function assetState(release, assets, complete = false) {
  const found = new Map()
  for (const asset of release.assets) {
    assert.ok(positiveId(asset.id) && assets.has(asset.name) && !found.has(asset.name), 'Unexpected or repeated native release asset')
    const expected = assets.get(asset.name)
    // GitHub documents an empty starter after a failed upload. Only that
    // incomplete expected asset can be removed, and only while still a draft.
    const starter = release.draft === true && asset.state === 'starter' && asset.size === 0
    assert.ok(starter || (asset.state === 'uploaded' && asset.size === expected.bytes && asset.digest === `sha256:${expected.sha256}`),
      'Existing release asset differs; never replace completed release bytes')
    assert.ok(!complete || !starter, 'Native release asset upload is incomplete')
    found.set(asset.name, asset)
  }
  assert.ok(!complete || found.size === assets.size, 'Native release is missing assets')
  return found
}

export async function publishNativeAssets({ bundle, sourceRevision, token, fetchImpl = fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const { inventory, assets } = bundle
  assert.equal(inventory.source_revision, sourceRevision, 'Bundle and publication source differ')
  const tag = `v${inventory.version}`, prerelease = publicationLane(inventory.version) === 'beta'
  // The repository-wide immutability setting and the tag ruleset's bypass list
  // need administration access this job's token deliberately lacks; the release
  // owner checks them beforehand. This job proves the outcome instead: the
  // published release must read back immutable before anything advances.
  await checkPublicProviderPosture({ token }, fetchImpl)
  assert.equal(await resolveTagCommit(fetchImpl, tag, token), sourceRevision, 'Release tag source differs')
  const api = nativeGithubClient(token, fetchImpl)
  // A draft has no by-tag address. Find this tag's one release in the list,
  // then read that exact release by ID through publication.
  const listed = []
  for (let page = 1; page <= 20; page += 1) {
    const batch = await api(`/releases?per_page=100&page=${page}`)
    assert.ok(Array.isArray(batch), 'GitHub release list is unavailable')
    listed.push(...batch.filter(entry => entry?.tag_name === tag))
    if (batch.length < 100) break
    assert.ok(page < 20, 'GitHub release list is too long to search safely')
  }
  assert.ok(listed.length === 1 && positiveId(listed[0].id), 'Exactly one GitHub release must exist for the admitted tag')
  const releaseId = listed[0].id
  const readRelease = () => api(`/releases/${releaseId}`)
  let release = await readRelease()
  identity(release, tag, prerelease)
  const sameRelease = () => { identity(release, tag, prerelease); assert.equal(release.id, releaseId, 'Release draft was replaced during publication') }
  const found = assetState(release, assets, !release.draft)
  if (release.draft) {
    for (const [name, expected] of assets) {
      const existing = found.get(name)
      if (existing?.state === 'uploaded') continue
      if (existing) await api(`/releases/assets/${existing.id}`, { method: 'DELETE' })
      const bytes = expected.read()
      assert.ok(bytes.length === expected.bytes && hash(bytes) === expected.sha256, 'Local release asset changed before upload')
      const uploaded = await api(`/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', body: bytes, raw: true, upload: true })
      // The upload response may precede GitHub's computed digest; the full
      // readback below requires every digest before the draft is published.
      assert.ok(positiveId(uploaded?.id) && uploaded.name === name && uploaded.state === 'uploaded' && uploaded.size === expected.bytes &&
        (uploaded.digest == null || uploaded.digest === `sha256:${expected.sha256}`), 'Uploaded release asset differs')
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      release = await readRelease()
      if (release.assets?.every(asset => typeof asset.digest === 'string')) break
      await delay(2000)
    }
    sameRelease(); assetState(release, assets, true)
    assert.equal(await resolveTagCommit(fetchImpl, tag, token), sourceRevision, 'Release tag changed before publication')
    if (release.draft) await api(`/releases/${release.id}`, { method: 'PATCH', body: { draft: false } })
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    release = await readRelease()
    if (!release.draft && release.immutable) break
    await delay(1000)
  }
  sameRelease(); assetState(release, assets, true)
  assert.ok(release.draft === false && release.immutable === true, 'Immutable publication readback is not complete; retry the same release')
  assert.equal(await resolveTagCommit(fetchImpl, tag, token), sourceRevision, 'Published tag source differs')
  return { release_id: release.id, tag, source_revision: sourceRevision, immutable: true, inventory_sha256: hash(bundle.signedInventory) }
}

/** Read-only admission for a later channel promotion, including resumed work. */
export async function verifyPublishedNativeAssets({ bundle, sourceRevision, token, fetchImpl = fetch }) {
  assert.equal(bundle.inventory.source_revision, sourceRevision, 'Bundle and promotion source differ')
  const tag = `v${bundle.inventory.version}`, prerelease = publicationLane(bundle.inventory.version) === 'beta'
  await checkPublicProviderPosture({ token, releaseTag: tag, expectedSha: sourceRevision }, fetchImpl)
  const release = await nativeGithubClient(token, fetchImpl)(`/releases/tags/${encodeURIComponent(tag)}`)
  identity(release, tag, prerelease); assetState(release, bundle.assets, true)
  assert.ok(release.draft === false && release.immutable === true, 'Channel promotion requires a published immutable release')
  return { release_id: release.id, tag, source_revision: sourceRevision, inventory_sha256: hash(bundle.signedInventory) }
}
