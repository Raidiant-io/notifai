#!/usr/bin/env node
/** Verify bundled skill placement and update integration from exact npm tarballs.
 * Packing/installing the tarballs uses bounded package-manager subprocesses;
 * skill setup itself runs with an empty PATH and never downloads an installer.
 * Usage: --cli-tarball a.tgz --expected-sha <sha> --owned-hosted-account; optional --if-changed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './cross-platform.mjs'
import {
  PACKED_SKILL_SMOKE_PATHS,
  skillSmokeWarranted,
} from './packed-skill-smoke.mjs'
import { requireStatus, runExternal } from './run-external.mjs'
import { preparePackedCli } from './verify-packed-install.mjs'

import { verifyPackedSkillInstaller } from './verify-installed-skill.mjs'

function fail(message) {
  console.error('Packed skill installer smoke FAILED:')
  console.error(`  - ${message}`)
  process.exit(1)
}

function argvValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function gitLines(args) {
  const result = runExternal('git', args, {
    cwd: repositoryRoot,
    timeoutMs: 5_000,
    phase: `git-${args[0]}`,
  })
  requireStatus(result)
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
}

export function changedFilesAgainstMain() {
  let base
  try {
    base = gitLines(['merge-base', 'origin/main', 'HEAD'])[0]
  } catch {
    try {
      base = gitLines(['merge-base', 'main', 'HEAD'])[0]
    } catch (error) {
      return { ok: false, files: null, reason: String(error) }
    }
  }
  if (typeof base !== 'string' || base === '') {
    return { ok: false, files: null, reason: 'could not resolve a main merge-base' }
  }
  try {
    return { ok: true, files: gitLines(['diff', '--name-only', base, 'HEAD']), base }
  } catch (error) {
    return { ok: false, files: null, reason: String(error) }
  }
}


async function main() {
  if (process.argv.includes('--if-changed')) {
    const changed = changedFilesAgainstMain()
    if (!changed.ok) {
      console.log(
        `phase skill-smoke-warrant: could not determine changed files (${changed.reason}); running the smoke.`,
      )
    } else if (!skillSmokeWarranted(changed.files)) {
      console.log(
        `Packed skill installer smoke skipped: no adapter, pin, or bundle change versus ${changed.base}. ` +
          `Warranted paths: ${PACKED_SKILL_SMOKE_PATHS.join(', ')}.`,
      )
      return
    } else {
      const warranted = changed.files.filter((file) => skillSmokeWarranted([file]))
      console.log(`phase skill-smoke-warrant: running because ${warranted.join(', ')} changed versus ${changed.base}`)
    }
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-packed-skill-install-'))
  try {
    const prepared = await preparePackedCli(scratch, {
      cliTarball: argvValue('--cli-tarball'),
      sourceRevision: argvValue('--expected-sha'),
    })
    console.log(JSON.stringify(await verifyPackedSkillInstaller(prepared, scratch)))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
