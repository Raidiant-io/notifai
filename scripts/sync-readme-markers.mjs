#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { repositoryRoot } from './cross-platform.mjs'

/**
 * Rewrites the root README's version markers from the package manifests.
 *
 * release-please cannot do this itself: `extra-files` rejects `../`, so no
 * package can reach the root README, and the generic updater has no
 * per-component markers for a file that names two packages. The release
 * workflow runs this on each release branch instead, after release-please
 * has bumped the manifests there.
 */
const root = repositoryRoot
const versions = {
  notifai: JSON.parse(readFileSync(path.join(root, 'apps/cli/package.json'), 'utf8')).version,
  protocol: JSON.parse(readFileSync(path.join(root, 'packages/protocol/package.json'), 'utf8'))
    .version,
}

const readmePath = path.join(root, 'README.md')
const readme = readFileSync(readmePath, 'utf8')
let updated = readme
for (const [component, version] of Object.entries(versions)) {
  const marker = new RegExp(
    `(<!--x-release-please-start-${component}-->)[^<]*(<!--x-release-please-end-->)`,
    'g',
  )
  if (!updated.match(marker)) {
    console.error(`README.md has no x-release-please-start-${component} marker`)
    process.exit(1)
  }
  updated = updated.replace(marker, `$1${version}$2`)
}

if (updated === readme) {
  console.log(
    `README version markers already current (notifai ${versions.notifai}, protocol ${versions.protocol})`,
  )
} else {
  writeFileSync(readmePath, updated)
  console.log(
    `README version markers synced (notifai ${versions.notifai}, protocol ${versions.protocol})`,
  )
}
