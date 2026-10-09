#!/usr/bin/env node
// Exact npm acquisition needs immutable assets, not a mutable channel default.
import { execFileSync } from 'node:child_process'
import { verifyNativePublication } from './verify-native-publication.mjs'
const [version, sourceRevision] = process.argv.slice(2)
const result = verifyNativePublication({ version, tagSha: sourceRevision, requireChannel: false,
  runCommand: (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 30_000 }) })
console.log(JSON.stringify({ ok: true, version: result.version, source_revision: result.source_revision,
  inventory_sha256: result.inventory_sha256 }))
