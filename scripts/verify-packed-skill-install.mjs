#!/usr/bin/env node
/**
 * Integration smoke: the published `skills` installer consumes the packed
 * Notifai skill through the packed production adapter.
 *
 * This is not part of `pnpm check:packed`. That gate is deterministic packed
 * proof (pin, isolated npm install of the tarballs, skill bundle, bin). This
 * smoke is the third-party seam that twice stalled indefinitely inside
 * `npm exec skills@…` after the registry metadata endpoint had already
 * responded. Run it when the native-skills adapter, installer pin, or
 * packaged skill bundle changes, and as release evidence before treating a
 * packed CLI as publishable. Every external process has a short explicit
 * timeout and a named phase so a stall fails this smoke instead of the
 * runner budget.
 *
 * Usage:
 *   node scripts/verify-packed-skill-install.mjs
 *   node scripts/verify-packed-skill-install.mjs --cli-tarball a.tgz --protocol-tarball b.tgz
 *   node scripts/verify-packed-skill-install.mjs --if-changed
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

async function assertInstallerMetadata(spec) {
  const separator = spec.lastIndexOf('@')
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`packed CLI installer spec ${spec} is not name@version`)
  }
  const name = spec.slice(0, separator)
  const version = spec.slice(separator + 1)
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  const started = Date.now()
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUTS.registryMetadata) })
  } catch (error) {
    const elapsedMs = Date.now() - started
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`phase skill-registry-metadata timed out after ${TIMEOUTS.registryMetadata}ms fetching ${url}`)
    }
    throw new Error(
      `phase skill-registry-metadata failed after ${elapsedMs}ms fetching ${url} (${String(error)})`,
    )
  }
  const elapsedMs = Date.now() - started
  if (!response.ok) {
    throw new Error(`phase skill-registry-metadata: ${url} responded ${response.status} in ${elapsedMs}ms`)
  }
  const body = await response.json()
  if (body.version !== version) {
    throw new Error(`phase skill-registry-metadata: expected ${spec}, registry returned ${body.version}`)
  }
  console.log(`phase skill-registry-metadata: ${url} responded ${response.status} in ${elapsedMs}ms`)
}

async function verifyPackedSkillInstaller(prepared, scratch) {
  const { installedCli, cliManifest, installDir } = prepared
  const native = await import(pathToFileURL(path.join(installedCli, 'dist', 'native-skills.js')).href)
  const platform = await import(pathToFileURL(path.join(installedCli, 'dist', 'platform.js')).href)
  const release = await import(pathToFileURL(path.join(installedCli, 'dist', 'release.js')).href)
  const integrity = await import(pathToFileURL(path.join(installedCli, 'dist', 'skill-integrity.js')).href)
  const commandsSkill = await import(pathToFileURL(path.join(installedCli, 'dist', 'commands-skill.js')).href)

  const sourceLabel = release.skillsSource()
  if (typeof sourceLabel !== 'string') throw new Error('packed CLI could not derive its skill release identity')
  if (typeof native.SKILLS_INSTALLER_SPEC !== 'string' || !native.SKILLS_INSTALLER_SPEC.startsWith('skills@')) {
    throw new Error('packed CLI does not pin a skills installer spec')
  }

  await assertInstallerMetadata(native.SKILLS_INSTALLER_SPEC)

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

  const staged = integrity.stageShippedSkillBundle(skillProject, cliManifest.version)
  if (!staged.ok) throw new Error(`packed CLI could not stage its packaged skill (${staged.error})`)
  try {
    const argv = native.skillsAddArgv({
      source: staged.staged.source,
      skill: 'notifai',
      scope: 'project',
      cwd: skillProject,
      env: skillEnv,
    })
    const launch = platform.npxLaunch(argv, {
      cwd: skillProject,
      env: skillEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log(
      `phase npm-exec-skills-installer: launching ${launch.file} ${launch.args.join(' ')} ` +
        `(registry metadata for ${native.SKILLS_INSTALLER_SPEC} already succeeded; ` +
        `timeout ${TIMEOUTS.npmExecSkills}ms)`,
    )
    const result = runExternal(launch.file, launch.args, {
      ...launch.options,
      timeoutMs: TIMEOUTS.npmExecSkills,
      phase: 'npm-exec-skills-installer',
    })
    try {
      requireStatus(result)
    } catch (error) {
      throw new Error(
        `${native.SKILLS_INSTALLER_SPEC} rejected the verified packaged local source (${String(error)})`,
      )
    }
  } finally {
    staged.staged.cleanup()
  }

  const lockFile = path.join(skillProject, 'skills-lock.json')
  const lockText = readFileSync(lockFile, 'utf8')
  const lock = JSON.parse(lockText)
  const lockSource = lock?.skills?.notifai?.source
  if (
    typeof lockSource !== 'string' ||
    path.isAbsolute(lockSource) ||
    /^[A-Za-z]:[\\/]/.test(lockSource) ||
    lockSource.startsWith('\\\\')
  ) {
    throw new Error(`${native.SKILLS_INSTALLER_SPEC} wrote a machine-specific skill source to its lock`)
  }
  for (const sensitivePath of [process.env.HOME, installDir, skillHome]) {
    if (sensitivePath && lockText.includes(sensitivePath)) {
      throw new Error(`${native.SKILLS_INSTALLER_SPEC} leaked a machine-specific path into its lock`)
    }
  }
  const stagingParent = path.join(skillProject, '.notifai')
  if (
    existsSync(stagingParent) &&
    readdirSync(stagingParent).some((entry) => entry.startsWith('skill-source-'))
  ) {
    throw new Error('packed CLI left its temporary skill source behind')
  }

  const readinessDeps = { nativeSkills: native.nativeSkills, cwd: skillProject, env: skillEnv }
  const installedRoot = path.join(skillProject, '.agents', 'skills', 'notifai')
  const installedStat = lstatSync(installedRoot)
  if (!installedStat.isDirectory() || installedStat.isSymbolicLink()) {
    throw new Error(`${native.SKILLS_INSTALLER_SPEC} did not leave the conventional installed skill as a regular copied tree`)
  }
  const ready = await commandsSkill.skillReadiness(readinessDeps, 'project')
  if (ready.status !== 'ready') {
    throw new Error(`freshly installed packaged skill was not ready (${JSON.stringify(ready.technical)})`)
  }
  const installedSkill = path.join(installedRoot, 'SKILL.md')
  writeFileSync(installedSkill, `${readFileSync(installedSkill, 'utf8')}\n<!-- altered -->\n`)
  const altered = await commandsSkill.skillReadiness(readinessDeps, 'project')
  if (altered.status !== 'gap' || altered.technical?.resolution !== 'installed-skill-content-mismatch') {
    throw new Error(`altered installed skill did not fail content readiness (${JSON.stringify(altered)})`)
  }

  console.log(
    `Packed skill installer smoke verified: ${native.SKILLS_INSTALLER_SPEC} consumed the packed ` +
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
