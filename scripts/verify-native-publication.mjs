import { createHash } from 'node:crypto'
import { Distribution, RELEASE_TARGETS } from '../apps/cli/dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/cli/dist/release-trust.js'
import { compareReleasePrecedence, isSemVer } from '../apps/cli/dist/version.js'

const repository = 'Raidiant-io/notifai'
const digest = value => createHash('sha256').update(value).digest('hex')

/** Read both pointers from one immutable metadata commit, just as the writer
 * publishes them. Completion must detect lag even when clients can recover. */
export function verifyNativeChannels({ runCommand, keys = RELEASE_PUBLIC_KEYS }) {
  const api = endpoint => JSON.parse(runCommand('gh', ['api', `repos/${repository}/${endpoint}`]))
  const ref = api('git/ref/heads/release-metadata').object
  if (ref?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(ref.sha)) throw new Error('Invalid native metadata ref')
  const verifier = new Distribution(keys)
  const records = Object.fromEntries(['stable', 'beta'].map(channel => {
    const bytes = Buffer.from(api(`contents/${channel}.json?ref=${ref.sha}`).content, 'base64').toString('utf8')
    return [channel, verifier.verifyChannel(bytes, channel)]
  }))
  if (compareReleasePrecedence(records.beta.version, records.stable.version) === 'before') {
    throw new Error('Native beta is behind stable')
  }
  if (records.beta.version === records.stable.version && records.beta.inventory_sha256 !== records.stable.inventory_sha256) {
    throw new Error('Native channels disagree on the same release inventory')
  }
  for (const record of Object.values(records)) {
    if (Object.values(records).some(other => other.withdrawn_versions.includes(record.version))) {
      throw new Error('Native channel recommends a withdrawn release')
    }
  }
  return records
}

// Reuse the shipped verifier; release-owner tooling has no separate trust root.
export function verifyNativePublication({ version, tagSha, runCommand, keys = RELEASE_PUBLIC_KEYS, requireCurrent = true, requireChannel = true,
  channel: channelName = version.includes('-') ? 'beta' : 'stable' }) {
  if (!isSemVer(version) || !/^[a-f0-9]{40}$/.test(tagSha)) throw new Error('An exact version and source SHA are required')
  if (!['stable', 'beta'].includes(channelName) || (channelName === 'stable' && version.includes('-'))) throw new Error('Invalid native release channel')
  const api = endpoint => JSON.parse(runCommand('gh', ['api', `repos/${repository}/${endpoint}`]))
  const release = api(`releases/tags/v${version}`)
  if (release.tag_name !== `v${version}` || release.draft !== false || release.immutable !== true ||
      release.prerelease !== version.includes('-') || !Array.isArray(release.assets)) {
    throw new Error('Native release must be immutable, published and in the selected channel')
  }
  let ref = api(`git/ref/tags/v${version}`).object
  for (let depth = 0; ref?.type === 'tag' && depth < 4; depth++) ref = api(`git/tags/${ref.sha}`).object
  if (ref?.type !== 'commit' || ref.sha !== tagSha) throw new Error('Native remote tag differs from the exact local tag')
  const verifier = new Distribution(keys)
  let channel
  if (requireChannel) {
    const channels = verifyNativeChannels({ runCommand, keys })
    channel = channels[channelName]
    if ((requireCurrent && channel.version !== version) || channel.withdrawn_versions.includes(version)) {
      throw new Error('Native announcement is superseded or withdrawn in its signed channel')
    }
    if (requireCurrent && channelName === 'beta' && version.includes('-') && compareReleasePrecedence(channels.stable.version, version) !== 'before') {
      throw new Error('Native beta announcement is superseded by the signed stable channel')
    }
  }
  const signedInventory = runCommand('gh', ['release', 'download', `v${version}`, '--repo', repository,
    '--pattern', 'inventory.json', '--output', '-'])
  // gh preserves asset bytes; unlike ordinary textual command output they must
  // not be trimmed before comparison with the signed channel digest.
  const inventory = verifier.verifyInventory(signedInventory)
  if ((channel?.version === version && digest(signedInventory) !== channel.inventory_sha256) || inventory.version !== version ||
      inventory.source_revision !== tagSha || inventory.artifacts.length !== RELEASE_TARGETS.length) {
    throw new Error('Native inventory does not match the signed channel, tag or full target set')
  }
  const expected = [{ filename: 'inventory.json', sha256: digest(signedInventory), bytes: Buffer.byteLength(signedInventory) },
    ...inventory.artifacts]
  for (const artifact of expected) {
    const matches = release.assets.filter(asset => asset.name === artifact.filename)
    if (matches.length !== 1 || matches[0].state !== 'uploaded' ||
        matches[0].digest !== `sha256:${artifact.sha256}` || matches[0].size !== artifact.bytes) {
      throw new Error(`Native release asset does not match authenticated inventory: ${artifact.filename}`)
    }
  }
  return { distribution: 'native', inventory_sha256: digest(signedInventory), channel_sequence: channel?.sequence, version: inventory.version, source_revision: inventory.source_revision, signedInventory, inventory }
}
