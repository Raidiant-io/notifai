// Signed release discovery is one atomic Git commit containing JSON + shell
// view. GitHub compares the exact expected branch head within the mutation.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Distribution } from '../apps/cli/dist/release-distribution.js'
import { bootstrapChannelText } from './generate-bootstrap-metadata.mjs'
import { signReleaseChannel } from './sign-release-records.mjs'
import { nativeGithubClient, verifyPublishedNativeAssets } from './publish-native-assets.mjs'

const sha = value => { assert.match(value ?? '', /^[a-f0-9]{40}$/, 'Invalid Git object identity'); return value }
const digest = value => createHash('sha256').update(value).digest('hex')
function contents(value) {
  if (value === null) return null
  assert.ok(value.type === 'file' && value.encoding === 'base64' && typeof value.content === 'string' &&
    Number.isSafeInteger(value.size) && value.size <= 256 * 1024, 'Invalid channel metadata file')
  const text = value.content.replace(/[\r\n]/g, ''), bytes = Buffer.from(text, 'base64')
  assert.ok(bytes.toString('base64') === text && bytes.length === value.size, 'Invalid channel metadata encoding')
  return bytes.toString('utf8')
}
export async function advanceNativeChannel({ bundle, sourceRevision, channel, token, initialize = false,
  withdraw = [], allowRollback = false, fetchImpl = fetch, ...signing }) {
  assert.ok(channel === 'stable' || channel === 'beta', 'Unknown release channel')
  // Do not create discovery for a draft, incomplete assets or another source.
  const published = await verifyPublishedNativeAssets({ bundle, sourceRevision, token, fetchImpl })
  const api = nativeGithubClient(token, fetchImpl), distribution = new Distribution(signing.trustedKeys)
  const ref = await api('/git/ref/heads/release-metadata', { missing: true })
  if (ref) assert.equal(ref.object?.type, 'commit', 'Release metadata ref must name a commit')
  const previousHead = ref ? sha(ref.object.sha) : null
  const read = async (file, revision) => contents(await api(`/contents/${file}?ref=${revision}`, { missing: true }))
  const previous = previousHead ? await read(`${channel}.json`, previousHead) : null
  assert.ok(previous !== null || initialize, 'Channel initialization must be explicit; never silently reset its sequence')
  const signed = signReleaseChannel({ ...signing, channel, signedInventory: bundle.signedInventory, previous, withdraw, allowRollback })
  const view = bootstrapChannelText(distribution, signed, channel, bundle.signedInventory)
  const oldView = previousHead ? await read(`${channel}.bootstrap.tsv`, previousHead) : null
  if (signed === previous && view === oldView) return { ...published, channel, changed: false, metadata_commit: previousHead,
    channel_sha256: digest(signed), sequence: distribution.verifyChannel(signed, channel).sequence }
  const additions = [[`${channel}.json`, signed], [`${channel}.bootstrap.tsv`, view]]
    .map(([name, bytes]) => ({ path: name, contents: Buffer.from(bytes).toString('base64') }))
  if (previousHead) {
    const result = await api('', { method: 'POST', graphql: true, body: {
      query: 'mutation AdvanceChannel($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
      variables: { input: { branch: { repositoryNameWithOwner: 'Raidiant-io/notifai', branchName: 'release-metadata' },
        expectedHeadOid: previousHead, message: { headline: `chore(release): advance ${channel} to ${bundle.inventory.version}` },
        fileChanges: { additions } } },
    } })
    assert.ok(!result.errors?.length && result.data?.createCommitOnBranch?.commit, 'Channel head changed or GitHub refused the commit; reread before retrying')
    sha(result.data.createCommitOnBranch.commit.oid)
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
    await api('/git/refs', { method: 'POST', body: { ref: 'refs/heads/release-metadata', sha: sha(commit.sha) } })
  }
  // Read both files at one immutable commit, even if another channel advanced
  // after us. A concurrent change to this channel is reported, never overwritten.
  const actualRef = await api('/git/ref/heads/release-metadata')
  assert.equal(actualRef.object?.type, 'commit')
  const actual = sha(actualRef.object.sha)
  assert.equal(await read(`${channel}.json`, actual), signed, 'Channel changed before publication readback; inspect before retrying')
  assert.equal(await read(`${channel}.bootstrap.tsv`, actual), view, 'Channel view differs after publication')
  return { ...published, channel, changed: true, metadata_commit: actual, channel_sha256: digest(signed),
    sequence: distribution.verifyChannel(signed, channel).sequence }
}
