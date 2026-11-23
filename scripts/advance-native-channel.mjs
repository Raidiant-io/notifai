// Signed release discovery is one atomic Git commit containing JSON + shell
// view. GitHub compares the exact expected branch head within the mutation.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Distribution } from '../apps/cli/dist/release-distribution.js'
import { bootstrapChannelText } from './generate-bootstrap-metadata.mjs'
import { signReleaseChannel } from './sign-release-records.mjs'
import { compareReleasePrecedence } from '../apps/cli/dist/version.js'
import { nativeGithubClient, verifyPublishedNativeAssets } from './publish-native-assets.mjs'

const sha = value => { assert.match(value ?? '', /^[a-f0-9]{40}$/, 'Invalid Git object identity'); return value }
const digest = value => createHash('sha256').update(value).digest('hex')
const READBACK_ATTEMPTS = 25
const READBACK_INTERVAL_MS = 5_000

function contents(value) {
  if (value === null) return null
  assert.ok(value.type === 'file' && value.encoding === 'base64' && typeof value.content === 'string' &&
    Number.isSafeInteger(value.size) && value.size <= 256 * 1024, 'Invalid channel metadata file')
  const text = value.content.replace(/[\r\n]/g, ''), bytes = Buffer.from(text, 'base64')
  assert.ok(bytes.toString('base64') === text && bytes.length === value.size, 'Invalid channel metadata encoding')
  return bytes.toString('utf8')
}

async function readBackChannel({ api, read, previousHead, writtenHead, files, wait }) {
  let observed
  for (let attempt = 1; attempt <= READBACK_ATTEMPTS; attempt += 1) {
    const ref = await api('/git/ref/heads/release-metadata', { missing: true })
    if (ref) assert.equal(ref.object?.type, 'commit', 'Release metadata ref must name a commit')
    const actual = ref ? sha(ref.object?.sha) : null
    observed = `last discovery head ${actual ?? 'missing'}`

    if (actual !== previousHead) {
      assert.ok(actual, 'Channel changed before publication readback: release-metadata disappeared')
      // First verify the immutable commit acknowledged by the write. A later
      // discovery head is acceptable only if it still serves the same files.
      const revisions = actual === writtenHead ? [writtenHead] : [writtenHead, actual]
      let missing
      for (const revision of revisions) {
        for (const [name, bytes] of files) {
          const visible = await read(name, revision)
          if (visible === null) {
            missing ??= `${name} unavailable at ${revision}`
            continue
          }
          assert.ok(visible === bytes, revision === writtenHead
            ? `Acknowledged channel commit ${writtenHead} differs at ${name}`
            : `Channel changed before publication readback: ${name} at ${actual} differs from ${writtenHead}`)
        }
      }
      if (!missing) return actual
      observed = `${observed}; ${missing}`
    }

    if (attempt < READBACK_ATTEMPTS) await wait(READBACK_INTERVAL_MS)
  }
  throw new Error(`Channel publication readback timed out for ${writtenHead} (${observed}); inspect before retrying`)
}

export async function advanceNativeChannel({ bundle, sourceRevision, channel, token, initialize = false,
  withdraw = [], allowRollback = false, fetchImpl = fetch, wait = delay, ...signing }) {
  assert.ok(channel === 'stable' || channel === 'beta', 'Unknown release channel')
  // Do not create discovery for a draft, incomplete assets or another source.
  const published = await verifyPublishedNativeAssets({ bundle, sourceRevision, token, fetchImpl })
  const api = nativeGithubClient(token, fetchImpl), distribution = new Distribution(signing.trustedKeys)
  const ref = await api('/git/ref/heads/release-metadata', { missing: true })
  if (ref) assert.equal(ref.object?.type, 'commit', 'Release metadata ref must name a commit')
  const previousHead = ref ? sha(ref.object.sha) : null
  const read = async (file, revision) => contents(await api(`/contents/${file}?ref=${revision}`, { missing: true }))
  const previous = previousHead ? await read(`${channel}.json`, previousHead) : null
  const otherChannel = channel === 'stable' ? 'beta' : 'stable'
  const otherPrevious = previousHead ? await read(`${otherChannel}.json`, previousHead) : null
  const other = otherPrevious === null ? null : distribution.verifyChannel(otherPrevious, otherChannel)
  assert.ok(!other?.withdrawn_versions.includes(bundle.inventory.version), 'Cannot recommend a withdrawn release')
  if (other?.version === bundle.inventory.version) {
    assert.equal(other.inventory_sha256, digest(bundle.signedInventory), 'A published version cannot change its signed inventory')
  }
  if (channel === 'beta' && other) {
    assert.notEqual(compareReleasePrecedence(bundle.inventory.version, other.version), 'before', 'Native beta cannot fall behind stable')
  }
  assert.ok(previous !== null || initialize, 'Channel initialization must be explicit; never silently reset its sequence')
  const signed = signReleaseChannel({ ...signing, channel, signedInventory: bundle.signedInventory, previous, withdraw, allowRollback })
  const view = bootstrapChannelText(distribution, signed, channel, bundle.signedInventory)
  const oldView = previousHead ? await read(`${channel}.bootstrap.tsv`, previousHead) : null
  const files = [[`${channel}.json`, signed], [`${channel}.bootstrap.tsv`, view]]
  let betaChanged = false
  if (channel === 'stable' && (!other || compareReleasePrecedence(other.version, bundle.inventory.version) === 'before')) {
    assert.ok(otherPrevious !== null || initialize, 'Beta channel initialization must be explicit')
    // Beta has its own sequence and withdrawal history; never copy stable's
    // envelope or overwrite a genuinely newer prerelease.
    const betaSigned = signReleaseChannel({ ...signing, channel: 'beta', signedInventory: bundle.signedInventory,
      previous: otherPrevious })
    files.push(['beta.json', betaSigned], ['beta.bootstrap.tsv', bootstrapChannelText(distribution, betaSigned, 'beta', bundle.signedInventory)])
    betaChanged = true
  }
  const finalRecords = files.filter(([name]) => name.endsWith('.json')).map(([name, bytes]) =>
    distribution.verifyChannel(bytes, name.slice(0, -5)))
  if (other && !betaChanged) finalRecords.push(other)
  for (const record of finalRecords) {
    assert.ok(!finalRecords.some(other => other.withdrawn_versions.includes(record.version)),
      'Cannot leave a channel recommending a withdrawn release')
  }
  if (signed === previous && view === oldView && !betaChanged) return { ...published, channel, changed: false, metadata_commit: previousHead,
    channel_sha256: digest(signed), sequence: distribution.verifyChannel(signed, channel).sequence }
  const additions = files
    .map(([name, bytes]) => ({ path: name, contents: Buffer.from(bytes).toString('base64') }))
  let writtenHead
  if (previousHead) {
    const result = await api('', { method: 'POST', graphql: true, body: {
      query: 'mutation AdvanceChannel($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
      variables: { input: { branch: { repositoryNameWithOwner: 'Raidiant-io/notifai', branchName: 'release-metadata' },
        expectedHeadOid: previousHead, message: { headline: `chore(release): advance ${channel} to ${bundle.inventory.version}` },
        fileChanges: { additions } } },
    } })
    if (result?.errors?.length) {
      const errors = result.errors.slice(0, 5).map(error => ({ type: error?.type, message: error?.message }))
      const details = JSON.stringify(errors).replaceAll(JSON.stringify(token).slice(1, -1), '[redacted]').slice(0, 1800)
      throw new Error(`GitHub refused the channel commit; reread before retrying: ${details}`)
    }
    const commit = result?.data?.createCommitOnBranch?.commit
    assert.ok(commit?.oid, 'GitHub did not acknowledge the channel commit; reread before retrying')
    writtenHead = sha(commit.oid)
  } else {
    // First creation is explicit and exclusive. POST refs cannot replace a ref
    // created by another publisher while the initial objects were prepared.
    const entries = []
    for (const addition of additions) {
      const blob = await api('/git/blobs', { method: 'POST', body: { content: addition.contents, encoding: 'base64' } })
      entries.push({ path: addition.path, mode: '100644', type: 'blob', sha: sha(blob.sha) })
    }
    const tree = await api('/git/trees', { method: 'POST', body: { tree: entries } })
    const commit = await api('/git/commits', { method: 'POST', body: {
      message: `chore(release): initialize ${channel} at ${bundle.inventory.version}`, tree: sha(tree.sha), parents: [],
    } })
    writtenHead = sha(commit.sha)
    await api('/git/refs', { method: 'POST', body: { ref: 'refs/heads/release-metadata', sha: writtenHead } })
  }
  const actual = await readBackChannel({ api, read, previousHead, writtenHead, files, wait })
  return { ...published, channel, changed: true, metadata_commit: actual, channel_sha256: digest(signed),
    sequence: distribution.verifyChannel(signed, channel).sequence }
}
