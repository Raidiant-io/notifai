#!/usr/bin/env node
// Protected workflow entrypoint. Every provider mutation requires explicit mode
// flags and an admitted signed bundle at the exact dispatched release tag/SHA.
import assert from 'node:assert/strict'
import { createHash, createPrivateKey } from 'node:crypto'
import { parseArgs } from 'node:util'
import { Distribution } from '../apps/cli/dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/cli/dist/release-trust.js'
import { nativeReleaseBundle, publishNativeAssets } from './publish-native-assets.mjs'
import { isSemVer } from '../apps/cli/dist/version.js'
import { validateReleaseSigner } from './sign-release-records.mjs'
import { requireUnifiedPublication } from './require-unified-publication.mjs'
import { advanceNativeChannel } from './advance-native-channel.mjs'

const { values } = parseArgs({ options: { directory: { type: 'string' }, 'expected-sha': { type: 'string' },
  publish: { type: 'boolean', default: false }, promote: { type: 'boolean', default: false },
  channel: { type: 'string' }, 'key-id': { type: 'string' }, 'initialize-channel': { type: 'boolean', default: false },
  'allow-channel-rollback': { type: 'boolean', default: false }, withdraw: { type: 'string', multiple: true, default: [] } } })
assert.ok(values.directory && /^[a-f0-9]{40}$/.test(values['expected-sha'] ?? ''), 'Bundle directory and exact source SHA are required')
assert.ok(values.publish !== values.promote, 'Publish candidates and promote discovery in separate operations')
assert.ok(values.promote || (!values.channel && !values['initialize-channel'] && !values['allow-channel-rollback'] && values.withdraw.length === 0),
  'Channel controls require explicit promotion')
assert.ok(Object.keys(RELEASE_PUBLIC_KEYS).length, 'Production release trust is not configured')
assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === 'Raidiant-io/notifai' &&
  process.env.GITHUB_SHA === values['expected-sha'], 'Publication must run in the protected exact-source repository workflow')
const distribution = new Distribution(RELEASE_PUBLIC_KEYS)
const bundle = nativeReleaseBundle(values.directory, distribution, values['expected-sha'])
assert.equal(process.env.GITHUB_REF, `refs/tags/v${bundle.inventory.version}`, 'Dispatched tag differs from signed bundle version')
assert.ok(values.withdraw.length <= 1000 && values.withdraw.every(value => value.length <= 100 && isSemVer(value)), 'Withdrawals must contain bounded exact versions')
assert.ok(!values.withdraw.includes(bundle.inventory.version), 'Cannot recommend the version being withdrawn')
const options = { bundle, sourceRevision: values['expected-sha'], token: process.env.GH_TOKEN }
let signing
if (values.promote) {
  assert.ok(values.channel === 'stable' || values.channel === 'beta', 'Promotion channel is required')
  assert.ok(values['key-id'] && Object.hasOwn(RELEASE_PUBLIC_KEYS, values['key-id']), 'Channel signing identity is not configured')
  assert.ok(process.env.NOTIFAI_RELEASE_SIGNING_KEY, 'Protected channel signing key is unavailable')
  signing = { keyId: values['key-id'], privateKey: createPrivateKey(process.env.NOTIFAI_RELEASE_SIGNING_KEY), trustedKeys: RELEASE_PUBLIC_KEYS }
  delete process.env.NOTIFAI_RELEASE_SIGNING_KEY
  validateReleaseSigner(signing)
}
// Validate local admission and all requested controls before the first mutation.
const result = {}
try {
  if (values.promote) result.admission = await requireUnifiedPublication({ version: bundle.inventory.version,
    sourceRevision: values['expected-sha'], requireNpmPointer: true })
  if (values.promote) assert.equal(result.admission.inventory_sha256,
    createHash('sha256').update(bundle.signedInventory).digest('hex'), 'Retained bundle differs from admitted npm/native inventory')
  if (values.publish) result.publication = await publishNativeAssets(options)
  if (values.promote) result.channel = await advanceNativeChannel({ ...options, ...signing, channel: values.channel,
    initialize: values['initialize-channel'], allowRollback: values['allow-channel-rollback'], withdraw: values.withdraw })
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, ...result, message: error.message,
    recovery: 'Inspect the exact tag and metadata state, then retry the same admitted bundle; never replace completed assets.' }) + '\n')
  process.exitCode = 1
}
