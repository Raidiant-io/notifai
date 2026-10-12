#!/usr/bin/env node
/** Verify bundled skill placement and update integration from exact npm tarballs.
 * Packing/installing the tarballs uses bounded package-manager subprocesses;
 * skill setup itself runs with an empty PATH and never downloads an installer.
 * Usage: --cli-tarball a.tgz --expected-sha <sha> --owned-hosted-account; optional --if-changed.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './cross-platform.mjs'
import {
  PACKED_SKILL_SMOKE_PATHS,
  PACKED_SKILL_SMOKE_TIMEOUTS,
  skillSmokeWarranted,
} from './packed-skill-smoke.mjs'
import { requireStatus, runExternal } from './run-external.mjs'
import { preparePackedCli } from './verify-packed-install.mjs'

const TIMEOUTS = PACKED_SKILL_SMOKE_TIMEOUTS

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

async function verifyPackedSkillInstaller(prepared, scratch) {
  // Source modules create only the existing-scope fixture. The distributed
  // native executable performs refresh/refusal; npm carries no product modules.
  const { nativeSkills } = await import('../apps/cli/dist/native-skills.js')
  const project = path.join(scratch, 'skill project Ω')
  mkdirSync(project)
  const env = { ...prepared.env, CODEX_HOME: path.join(prepared.home, 'codex'),
    XDG_CONFIG_HOME: path.join(prepared.home, 'config'), XDG_STATE_HOME: path.join(prepared.home, 'state'),
    PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '' }
  const seeded = await nativeSkills.add({ skill: 'notifai', scope: 'project', agents: ['codex'], cwd: project, env })
  if (seeded !== 0) throw new Error('Could not prepare an owned existing skill scope')
  const execute = phase => runExternal(prepared.nativeCommand, ['update', '--refresh-skill', '--json'], {
    cwd: project, env, timeoutMs: TIMEOUTS.cliCommand, phase })
  const first = requireStatus(execute('native-packed-skill-refresh'))
  if (JSON.parse(first.stdout).ok !== true) throw new Error('Native bundled skill disagrees with reviewed scope fixture')
  const skill = path.join(project, '.agents/skills/notifai/SKILL.md')
  const original = readFileSync(skill, 'utf8')
  writeFileSync(skill, original + '\n<!-- user edit -->\n')
  const refused = execute('native-packed-skill-user-edit')
  if (refused.status === 0 || !readFileSync(skill, 'utf8').endsWith('<!-- user edit -->\n')) {
    throw new Error('Native skill refresh did not preserve a user edit')
  }
  writeFileSync(skill, original)
  const retry = requireStatus(execute('native-packed-skill-retry'))
  if (JSON.parse(retry.stdout).ok !== true || readFileSync(skill, 'utf8') !== original) throw new Error('Native skill refresh retry changed reviewed content')
  console.log(JSON.stringify({ ok: true, build: prepared.nativeReceipt.build,
    checks: ['signed-native-bundle', 'native-owned-scope-refresh', 'user-edit-preservation', 'idempotent-refresh'] }))
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
    await verifyPackedSkillInstaller(prepared, scratch)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
