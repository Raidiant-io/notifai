#!/usr/bin/env node
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { Distribution } from './shared/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from './shared/release-trust.js'
import { isSemVer } from './shared/version.js'
import { installStandalone } from './bootstrap.mjs'
import { nativePlatform } from './platform.mjs'

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, json: { type: 'boolean' },
    version: { type: 'string' }, channel: { type: 'string' }, 'no-init': { type: 'boolean' }, 'no-path': { type: 'boolean' }, 'migrate-npm': { type: 'boolean' } } })
  if (values.help) {
    console.log('Usage: notifai-install [--version <runtime-version>] [--channel stable|beta] [--json] [--no-init] [--no-path] [--migrate-npm]\nInstalls the standalone Notifai CLI. Later runtime updates use notifai update. No install lifecycle script runs automatically.')
  } else {
    assert.ok(!values.version || isSemVer(values.version), '--version requires an exact runtime SemVer')
    assert.ok(!values.channel || ['stable', 'beta'].includes(values.channel), '--channel must be stable or beta')
    assert.ok(!values.version?.split('+')[0].includes('-') || values.channel === 'beta', 'Prerelease installation requires --channel beta')
    // Existing owned installations are reusable even when this old bootstrap
    // has no current release key. First installation fails in Distribution.
    process.exitCode = await installStandalone(values, { platform: nativePlatform(), distribution: () => {
      assert.ok(Object.keys(RELEASE_PUBLIC_KEYS).length, 'This installer has no configured release trust; first installation is not published yet')
      return new Distribution(RELEASE_PUBLIC_KEYS)
    } })
  }
} catch (error) {
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, code: 'bootstrap_failed', message: error.message }))
  else console.error(`Notifai installation failed: ${error.message}`)
  process.exitCode = 1
}
