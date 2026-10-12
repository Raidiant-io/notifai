import { createHash } from 'node:crypto'
import { Distribution, RELEASE_TARGETS } from '../apps/cli/dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/cli/dist/release-trust.js'
import { compareReleasePrecedence, isSemVer } from '../apps/cli/dist/version.js'

const repository = 'Raidiant-io/notifai'
const digest = value => createHash('sha256').update(value).digest('hex')

// Reuse the shipped verifier; release-owner tooling has no separate trust root.
export function verifyNativePublication({ version, tagSha, runCommand, keys = RELEASE_PUBLIC_KEYS, requireCurrent = true, requireChannel = true }) {
  if (!isSemVer(version) || !/^[a-f0-9]{40}$/.test(tagSha)) throw new Error('An exact version and source SHA are required')
  const channelName = version.includes('-') ? 'beta' : 'stable'
  const api = endpoint => JSON.parse(runCommand('gh', ['api', `repos/${repository}/${endpoint}`]))
  const release = api(`releases/tags/v${version}`)
  if (release.tag_name !== `v${version}` || release.draft !== false || release.immutable !== true ||
      release.prerelease !== (channelName === 'beta') || !Array.isArray(release.assets)) {
    throw new Error('Native release must be immutable, published and in the selected channel')
  }
  let ref = api(`git/ref/tags/v${version}`).object
  for (let depth = 0; ref?.type === 'tag' && depth < 4; depth++) ref = api(`git/tags/${ref.sha}`).object
  if (ref?.type !== 'commit' || ref.sha !== tagSha) throw new Error('Native remote tag differs from the exact local tag')
  const verifier = new Distribution(keys)
  let channel
  if (requireChannel) {
    const signedChannel = Buffer.from(api(`contents/${channelName}.json?ref=release-metadata`).content, 'base64').toString('utf8')
    channel = verifier.verifyChannel(signedChannel, channelName)
    if ((requireCurrent && channel.version !== version) || channel.withdrawn_versions.includes(version)) {
      throw new Error('Native announcement is superseded or withdrawn in its signed channel')
    }
    if (requireCurrent && channelName === 'beta') {
      const metadata = api('contents?ref=release-metadata')
      if (!Array.isArray(metadata)) throw new Error('Cannot inspect native channel availability')
      if (metadata.some(entry => entry.name === 'stable.json')) {
        const stableBytes = Buffer.from(api('contents/stable.json?ref=release-metadata').content, 'base64').toString('utf8')
        const stable = verifier.verifyChannel(stableBytes, 'stable')
        if (compareReleasePrecedence(stable.version, version.split('-')[0]) !== 'before') {
          throw new Error('Native beta announcement is superseded by the signed stable channel')
        }
      }
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
