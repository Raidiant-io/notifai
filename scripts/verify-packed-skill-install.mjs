#!/usr/bin/env node
/** Verify bundled skill placement and update integration from exact npm tarballs.
 * Packing/installing the tarballs uses bounded package-manager subprocesses;
 * skill setup itself runs with an empty PATH and never downloads an installer.
 * Usage: --cli-tarball a.tgz --protocol-tarball b.tgz; optional --if-changed.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const { installedCli, cliManifest, installDir } = prepared
  const native = await import(pathToFileURL(path.join(installedCli, 'dist', 'native-skills.js')).href)
  const commandsSkill = await import(pathToFileURL(path.join(installedCli, 'dist', 'commands-skill.js')).href)
  const adapter = await import(pathToFileURL(path.join(installedCli, 'dist', 'hook-adapter.js')).href)

  const skillProject = path.join(scratch, 'skill project Ω')
  const skillHome = path.join(scratch, 'skill home')
  mkdirSync(skillProject, { recursive: true })
  mkdirSync(skillHome, { recursive: true })
  writeFileSync(
    path.join(skillProject, 'package.json'),
    JSON.stringify({ name: 'notifai-skill-install-smoke', private: true }, null, 2),
  )
  const skillEnv = {
    ...process.env,
    CI: 'true',
    HOME: skillHome,
    USERPROFILE: skillHome,
    XDG_CONFIG_HOME: path.join(skillHome, 'config'),
    XDG_STATE_HOME: path.join(skillHome, 'state'),
    npm_config_cache: path.join(scratch, 'npm-cache'),
    npm_config_yes: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_progress: 'false',
    npm_config_update_notifier: 'false',
  }

  const result = await native.nativeSkills.add({ skill: 'notifai', scope: 'project',
    agents: ['codex'], cwd: skillProject, env: { ...skillEnv, PATH: '' } })
  if (result !== 0) throw new Error(`Bundled placement failed: ${JSON.stringify(result)}`)
  if (existsSync(path.join(skillProject, 'skills-lock.json'))) throw new Error('Bundled placement wrote an external installer lock')

  const readinessDeps = { nativeSkills: native.nativeSkills, cwd: skillProject, env: skillEnv }
  const installedRoot = path.join(skillProject, '.agents', 'skills', 'notifai')
  const installedStat = lstatSync(installedRoot)
  if (!installedStat.isDirectory() || installedStat.isSymbolicLink()) {
    throw new Error('Bundled placement did not leave a regular copied skill tree')
  }
  const ready = await commandsSkill.skillReadiness(readinessDeps, 'project')
  if (ready.status !== 'ready') {
    throw new Error(`freshly installed packaged skill was not ready (${JSON.stringify(ready.technical)})`)
  }
  const installedSkill = path.join(installedRoot, 'SKILL.md')
  const originalSkill = readFileSync(installedSkill, 'utf8')
  writeFileSync(installedSkill, `${originalSkill}\n<!-- altered -->\n`)
  const altered = await commandsSkill.skillReadiness(readinessDeps, 'project')
  if (altered.status !== 'gap' || altered.technical?.resolution !== 'installed-skill-content-mismatch') {
    throw new Error(`altered installed skill did not fail content readiness (${JSON.stringify(altered)})`)
  }

  const refused = await native.nativeSkills.add({ skill: 'notifai', scope: 'project', cwd: skillProject,
    env: { ...skillEnv, PATH: '' } })
  if (refused === 0 || !readFileSync(installedSkill, 'utf8').includes('<!-- altered -->')) throw new Error('Skill refresh did not preserve a user edit')
  writeFileSync(installedSkill, originalSkill)

  // Exercise the packed production command tree and bundled installer.
  // Adapter tests must supply an explicit fixture home: mutable HOME alone
  // cannot redirect the account's trusted shared adapter.
  const migrationEnv = { ...skillEnv,
    CODEX_HOME: path.join(skillHome, 'codex'),
    PATH: [path.join(installDir, 'node_modules', '.bin'), skillEnv.PATH].join(path.delimiter),
  }
  for (const key of ['CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CURSOR_AGENT',
    'GROK_SESSION_ID', 'HERMES_SESSION_ID', 'NOTIFAI_ACTIVE_HARNESS', 'NOTIFAI_ACTIVE_SESSION_ID']) delete migrationEnv[key]
  const runner = path.join(scratch, 'packed-migration-runner.mjs')
  writeFileSync(runner, `
const base = ${JSON.stringify(pathToFileURL(path.join(installedCli, 'dist')).href + '/')};
const { buildProgram } = await import(base + 'program.js');
const { realIo } = await import(base + 'commands.js');
const { nativeSkills } = await import(base + 'native-skills.js');
const forbidden = () => { throw new Error('local migration accessed service or credentials'); };
const deps = { env: process.env, cwd: process.cwd(), io: realIo(), nativeSkills,
  hookAdapterHome: ${JSON.stringify(skillHome)},
  hookInstallTarget: { execPath: process.execPath, scriptPath: ${JSON.stringify(path.join(installedCli, 'dist', 'main.js'))} },
  fetchImpl: forbidden, clientFactory: forbidden,
  store: { load: forbidden, save: forbidden, clear: forbidden, describe: forbidden } };
await buildProgram(deps).parseAsync([process.execPath, 'notifai', ...process.argv.slice(2)]);
`)
  const execute = (args, phase) => {
    const result = runExternal(process.execPath, [runner, ...args], {
      cwd: skillProject, env: migrationEnv, timeoutMs: TIMEOUTS.cliCommand, phase,
    })
    requireStatus(result)
    return result
  }
  execute(['hooks', 'install', '--harness', 'codex'], 'packed-migration-hooks')
  const hookFile = path.join(migrationEnv.CODEX_HOME, 'hooks.json')
  const hooks = JSON.parse(readFileSync(hookFile, 'utf8'))
  hooks.hooks.PostToolUse = [{ hooks: [{ type: 'command', command: 'foreign-tool-handler' }] }]
  writeFileSync(hookFile, JSON.stringify(hooks))
  const trustFile = path.join(migrationEnv.CODEX_HOME, 'config.toml')
  const trust = '# User-owned native trust is unchanged\n'
  writeFileSync(trustFile, trust)
  const resume = JSON.parse(execute(['update', '--resume', '--json'], 'packed-update-resume').stdout)
  if (resume.files_complete !== true || resume.migration_complete !== false ||
      !resume.pending_actions.some(action => action.includes('native-approval-pending'))) {
    throw new Error(`packed migration did not distinguish files from native approval (${JSON.stringify(resume)})`)
  }
  const refreshed = await commandsSkill.skillReadiness(readinessDeps, 'project')
  const repaired = readFileSync(hookFile, 'utf8')
  if (refreshed.status !== 'ready' || !repaired.includes('post-tool-use') ||
      !repaired.includes('foreign-tool-handler') || readFileSync(trustFile, 'utf8') !== trust) {
    throw new Error('packed migration did not preserve foreign hooks/trust while refreshing owned files')
  }
  const retried = JSON.parse(execute(['update', '--resume', '--json'], 'packed-update-resume-retry').stdout)
  if (retried.files_complete !== true || retried.changed.length !== 0 ||
      readFileSync(hookFile, 'utf8') !== repaired || readFileSync(trustFile, 'utf8') !== trust) {
    throw new Error('packed migration retry changed already repaired files or User-owned trust')
  }
  const competitor = path.join(scratch, 'competing prefix')
  cpSync(path.join(installDir, 'node_modules'), path.join(competitor, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  const adapterFile = adapter.hookAdapterPath(skillHome)
  const adapterBefore = readFileSync(adapterFile, 'utf8')
  const competingResult = runExternal(process.execPath, [runner, 'update', '--resume', '--json'], {
    cwd: skillProject, env: { ...migrationEnv,
      PATH: [path.join(competitor, 'node_modules', '.bin'), migrationEnv.PATH].join(path.delimiter) },
    timeoutMs: TIMEOUTS.cliCommand, phase: 'packed-competing-installation',
  })
  if (competingResult.status !== 1 || JSON.parse(competingResult.stdout).files_complete !== false ||
      readFileSync(adapterFile, 'utf8') !== adapterBefore || readFileSync(hookFile, 'utf8') !== repaired) {
    throw new Error('packed migration did not refuse a competing effective artifact without shared-file changes')
  }

  console.log(
    `Bundled skill installer verified from packed ` +
      `${cliManifest.name}@${cliManifest.version} skill.`,
  )
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
      protocolTarball: argvValue('--protocol-tarball'),
      scanSecrets: false,
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
