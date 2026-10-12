#!/usr/bin/env node
// Bind a generated payload to the already-published immutable native inventory.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Distribution } from '../apps/cli/dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/cli/dist/release-trust.js'
import { bindAdapterInventory } from './npm-adapter-artifact.mjs'
import { verifyNativePublication } from './verify-native-publication.mjs'
import { repositoryRoot } from './cross-platform.mjs'
const [version, sourceRevision] = process.argv.slice(2)
const evidence = verifyNativePublication({ version, tagSha: sourceRevision, requireChannel: false,
  runCommand: (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 30_000 }) })
bindAdapterInventory(path.join(repositoryRoot, 'dist/npm/notifai'), evidence.signedInventory, new Distribution(RELEASE_PUBLIC_KEYS))
