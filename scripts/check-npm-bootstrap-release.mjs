#!/usr/bin/env node
// Publication readiness consumes the built bootstrap trust, never ambient keys.
import assert from 'node:assert/strict'
import { Distribution, RELEASE_TARGETS } from '../packages/installer/dist/shared/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../packages/installer/dist/shared/release-trust.js'

assert.ok(Object.keys(RELEASE_PUBLIC_KEYS).length, 'Configure reviewed release public keys before publishing the npm installer')
// The default invocation installs stable even when the bootstrap package itself
// is a beta. Do not publish a bootstrap whose default cannot resolve a release.
const distribution = new Distribution(RELEASE_PUBLIC_KEYS)
for (const target of RELEASE_TARGETS) {
  const result = await distribution.resolveRelease({ channel: 'stable', target })
  console.log(`Verified signed stable release ${result.inventory.version} for ${target}`)
}
