#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { behaviorDigest } from './check-agent-guidance.mjs'
import { repositoryRoot } from './cross-platform.mjs'

// Conservatively include every shipped CLI source: guidance can be emitted by
// any adapter. Order and whitespace matter; no local read receipt is involved.
export function shippedGuidanceDigest(root) {
  return behaviorDigest(root, ['apps/cli/src', 'skills/notifai']).slice(7)
}
export function checkGuidanceChanges(root) {
  const catalog = JSON.parse(readFileSync(path.join(root, 'skills/guidance-changes.json'), 'utf8'))
  const digest = shippedGuidanceDigest(root)
  if (catalog.current !== digest || catalog.releases?.at(-1)?.digest !== digest) {
    throw new Error('Shipped guidance changed without a release-authored note. Run pnpm guidance:note --file <note-file>.')
  }
  const seen = new Set()
  for (const release of catalog.releases) {
    if (!/^[a-f0-9]{64}$/.test(release.digest) || seen.has(release.digest) ||
      typeof release.note !== 'string' || !release.note.trim() || Buffer.byteLength(release.note) > 16000) throw new Error('Malformed guidance change note')
    seen.add(release.digest)
  }
  return catalog
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args[0] === '--file' && args.length === 2) {
    const file = path.join(repositoryRoot, 'skills/guidance-changes.json')
    const catalog = JSON.parse(readFileSync(file, 'utf8'))
    const digest = shippedGuidanceDigest(repositoryRoot)
    const note = readFileSync(args[1], 'utf8').trim()
    if (catalog.releases.some(release => release.digest === digest)) throw new Error('This digest already has an authored note')
    catalog.current = digest
    catalog.releases.push({ digest, note })
    writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n')
  }
  checkGuidanceChanges(repositoryRoot)
}
