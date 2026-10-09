#!/usr/bin/env node
import { readFileSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Distribution } from '../dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../dist/release-trust.js'
import { verifyNpmAdapterArtifact } from '../dist/npm-adapter-verification.js'
import { runNpmAdapter } from './adapter.mjs'
import { nativePlatform } from './platform.mjs'

try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const file = path.join(root, 'data/release.json')
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid npm adapter release locator')
  const locator = JSON.parse(readFileSync(file, 'utf8'))
  const platform = nativePlatform(), distribution = new Distribution(RELEASE_PUBLIC_KEYS)
  process.exitCode = await runNpmAdapter(process.argv.slice(2), { locator, platform, distribution,
    verify: () => verifyNpmAdapterArtifact(root, distribution, platform.checkAccess) })
} catch (error) {
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, code: 'bootstrap_failed', message: error.message }))
  else console.error(`Notifai: ${error.message}`)
  process.exitCode = 1
}
