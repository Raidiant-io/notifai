#!/usr/bin/env node
// Read the hosted runner's OS identity; create only a unique temporary folder.
import assert from 'node:assert/strict'
import { lstatSync, rmSync } from 'node:fs'
import { nativePlatform } from '../packages/installer/dist/platform.mjs'

const platform = nativePlatform()
assert.equal(platform.existingCommand(), null, 'Hosted bootstrap proof requires a clean runner with no existing native installation')
assert.equal(platform.target(), process.argv[2], 'npm bootstrap must select the native runner target')
const temporary = platform.temporaryDirectory()
try {
  const stat = lstatSync(temporary)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink())
  if (process.platform !== 'win32') assert.ok(stat.uid === process.getuid() && (stat.mode & 0o077) === 0)
  // The Windows helper verifies its private owner/DACL before returning.
  console.log(JSON.stringify({ ok: true, target: process.argv[2], checks: ['os-account-home', 'native-target', 'private-temporary-directory'] }))
} finally { rmSync(temporary, { recursive: true, force: true }) }
