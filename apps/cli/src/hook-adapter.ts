import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { withTargetFileLock } from './file-lock.js'

const ADAPTER_MARKER = '# notifai managed hook adapter'
const WIN32_ADAPTER_MARKER = '// notifai managed hook adapter'
const ADAPTER_VERSION = 1

export type HookHostPlatform = 'posix' | 'win32'

export interface HookAdapterFileTarget {
  kind?: 'file'
  execPath: string
  scriptPath: string
}

export interface HookAdapterNpxTarget {
  kind: 'npx'
  execPath: string
  npmCli: string
  spec: string
}

export type HookAdapterTarget = HookAdapterFileTarget | HookAdapterNpxTarget

export function isNpxAdapterTarget(target: HookAdapterTarget): target is HookAdapterNpxTarget {
  return target.kind === 'npx'
}

export interface HookAdapterInspection {
  path: string
  target: HookAdapterTarget | null
  problems: string[]
}

export function hookHostPlatform(
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): HookHostPlatform {
  return platform === 'win32' ? 'win32' : 'posix'
}

/**
 * One user-level identity for every harness and every project/global install.
 *
 * The pathname is deliberately outside XDG configuration/state routing. XDG
 * overrides routinely differ between shells, package managers, and harness
 * processes; allowing one to select this path would put mutable environment
 * back into every trusted definition. Only the user's home boundary selects
 * it; CLI, Node, package-manager, checkout, and preference paths stay behind
 * it and may change without changing hook identity.
 */
export function hookAdapterPath(homeDir: string = os.userInfo().homedir): string {
  return path.join(homeDir, '.notifai', 'bin', 'hook-adapter')
}

/** Install or repair the stable adapter and atomically retarget its implementation. */
export function installHookAdapter(
  target: HookAdapterTarget,
  homeDir?: string,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): { path: string; changed: boolean } {
  const host = hookHostPlatform(platform)
  assertUsableTarget(target, host)
  const file = hookAdapterPath(homeDir)
  ensureManagedDirectories(homeDir ?? os.userInfo().homedir, host)
  const source = hookAdapterSource(target, host)
  return withTargetFileLock(file, () => {
    const existing = existsSync(file) ? readSafeManagedFile(file) : null
    const modeDrift =
      host === 'posix' && existing !== null && (existing.mode & 0o777) !== 0o700
    const changed = existing === null || existing.contents !== source || modeDrift
    if (changed) {
      atomicWriteFileSync(file, source, {
        mode: host === 'posix' ? 0o700 : 0o600,
        preserveMode: false,
        requireCurrentUserOwner: true,
      })
    }
    return { path: file, changed }
  })
}

function assertUsableTarget(target: HookAdapterTarget, host: HookHostPlatform): void {
  let exec
  try {
    exec = statSync(target.execPath)
  } catch {
    throw new Error(`Hook adapter runtime ${target.execPath} does not exist.`)
  }
  if (!exec.isFile() || (host === 'posix' && (exec.mode & 0o111) === 0)) {
    throw new Error(`Hook adapter runtime ${target.execPath} is not executable.`)
  }
  if (isNpxAdapterTarget(target)) {
    if (target.spec.trim() === '') {
      throw new Error('Hook adapter npx spec is empty.')
    }
    try {
      if (!statSync(target.npmCli).isFile()) {
        throw new Error(`Hook adapter npm CLI ${target.npmCli} is not a regular file.`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Hook adapter npm CLI ')) throw err
      throw new Error(`Hook adapter npm CLI ${target.npmCli} does not exist.`)
    }
    return
  }
  try {
    if (!statSync(target.scriptPath).isFile()) {
      throw new Error(`Hook adapter CLI ${target.scriptPath} is not a regular file.`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Hook adapter CLI ')) throw err
    throw new Error(`Hook adapter CLI ${target.scriptPath} does not exist.`)
  }
}

/** Inspect the shared adapter without executing either it or its registered CLI. */
export function inspectHookAdapter(
  homeDir?: string,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): HookAdapterInspection {
  const host = hookHostPlatform(platform)
  const file = hookAdapterPath(homeDir)
  if (!existsSync(file)) {
    return { path: file, target: null, problems: [`${file} is missing; rerun \`notifai hooks install\``] }
  }

  let stat
  try {
    stat = lstatSync(file)
  } catch (err) {
    return { path: file, target: null, problems: [String(err)] }
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return {
      path: file,
      target: null,
      problems: [`${file} is not a regular file; refusing the adapter`],
    }
  }

  const problems: string[] = []
  if (host === 'posix') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (uid !== undefined && stat.uid !== uid) {
      problems.push(`${file} is owned by uid ${stat.uid}, not the current user`)
    }
    if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700) {
      problems.push(`${file} permissions are ${(stat.mode & 0o777).toString(8)}, expected 700`)
    }
  }

  const contents = readFileSync(file, 'utf8')
  const format = adapterFormat(contents)
  if (format === null) {
    problems.push(`${file} has no managed adapter marker`)
  } else if (format !== host) {
    problems.push(`${file} is not a ${host} managed adapter; rerun \`notifai hooks install\``)
  }
  const version = Number(meta(contents, 'adapter-version') ?? Number.NaN)
  if (version !== ADAPTER_VERSION) problems.push(`${file} uses obsolete adapter version ${version}`)
  const target = parseTarget(contents)
  if (target === null) {
    problems.push(`${file} has malformed target metadata`)
  } else {
    try {
      const exec = statSync(target.execPath)
      if (!exec.isFile() || (host === 'posix' && (exec.mode & 0o111) === 0)) {
        problems.push(`registered runtime ${target.execPath} is not executable`)
      }
    } catch {
      problems.push(`registered runtime ${target.execPath} is missing`)
    }
    if (isNpxAdapterTarget(target)) {
      if (target.spec.trim() === '') problems.push('registered npx spec is empty')
      try {
        if (!statSync(target.npmCli).isFile()) {
          problems.push(`registered npm CLI ${target.npmCli} is not a regular file`)
        }
      } catch {
        problems.push(`registered npm CLI ${target.npmCli} is missing`)
      }
    } else {
      try {
        if (!statSync(target.scriptPath).isFile()) {
          problems.push(`registered CLI ${target.scriptPath} is not a regular file`)
        }
      } catch {
        problems.push(`registered CLI ${target.scriptPath} is missing`)
      }
    }
  }
  return { path: file, target, problems }
}

/** Generate the managed adapter source for one host. Exported so tests can pin bytes. */
export function hookAdapterSource(
  target: HookAdapterTarget,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  return hookHostPlatform(platform) === 'win32'
    ? win32HookAdapterSource(target)
    : posixHookAdapterSource(target)
}

function posixHookAdapterSource(target: HookAdapterTarget): string {
  if (isNpxAdapterTarget(target)) {
    return `#!/bin/sh
${ADAPTER_MARKER}
# adapter-version: ${ADAPTER_VERSION}
# target-kind: npx
# target-exec-json: ${JSON.stringify(target.execPath)}
# target-npm-cli-json: ${JSON.stringify(target.npmCli)}
# target-spec-json: ${JSON.stringify(target.spec)}
set -eu

registered_exec=${quote(target.execPath)}
registered_npm_cli=${quote(target.npmCli)}
registered_spec=${quote(target.spec)}

if [ -x "$registered_exec" ] && [ -f "$registered_npm_cli" ]; then
  exec "$registered_exec" "$registered_npm_cli" exec --yes --package "$registered_spec" -- notifai "$@"
fi

printf '%s\n' 'Notifai hook adapter target is stale; run notifai hooks install.' >&2
exit 127
`
  }
  return `#!/bin/sh
${ADAPTER_MARKER}
# adapter-version: ${ADAPTER_VERSION}
# target-exec-json: ${JSON.stringify(target.execPath)}
# target-script-json: ${JSON.stringify(target.scriptPath)}
set -eu

registered_exec=${quote(target.execPath)}
registered_script=${quote(target.scriptPath)}

if [ -x "$registered_exec" ] && [ -f "$registered_script" ]; then
  exec "$registered_exec" "$registered_script" "$@"
fi

printf '%s\n' 'Notifai hook adapter target is stale; run notifai hooks install.' >&2
exit 127
`
}

function win32HookAdapterSource(target: HookAdapterTarget): string {
  const header = isNpxAdapterTarget(target)
    ? `${WIN32_ADAPTER_MARKER}
// adapter-version: ${ADAPTER_VERSION}
// target-kind: npx
// target-exec-json: ${JSON.stringify(target.execPath)}
// target-npm-cli-json: ${JSON.stringify(target.npmCli)}
// target-spec-json: ${JSON.stringify(target.spec)}
`
    : `${WIN32_ADAPTER_MARKER}
// adapter-version: ${ADAPTER_VERSION}
// target-exec-json: ${JSON.stringify(target.execPath)}
// target-script-json: ${JSON.stringify(target.scriptPath)}
`
  const argv = isNpxAdapterTarget(target)
    ? `[${JSON.stringify(target.npmCli)}, "exec", "--yes", "--package", ${JSON.stringify(target.spec)}, "--", "notifai", ...process.argv.slice(2)]`
    : `[${JSON.stringify(target.scriptPath)}, ...process.argv.slice(2)]`
  const companion = isNpxAdapterTarget(target)
    ? JSON.stringify(target.npmCli)
    : JSON.stringify(target.scriptPath)
  return `${header}"use strict";
const { spawnSync } = require("node:child_process");
const { statSync } = require("node:fs");
const registeredExec = ${JSON.stringify(target.execPath)};
const registeredCompanion = ${companion};

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

if (isFile(registeredExec) && isFile(registeredCompanion)) {
  const result = spawnSync(registeredExec, ${argv}, {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write("Notifai hook adapter target is stale; run notifai hooks install.\\n");
    process.exit(127);
  }
  process.exit(result.status === null ? 1 : result.status);
}

process.stderr.write("Notifai hook adapter target is stale; run notifai hooks install.\\n");
process.exit(127);
`
}

function adapterFormat(contents: string): HookHostPlatform | null {
  if (contents.startsWith(`#!/bin/sh\n${ADAPTER_MARKER}\n`)) return 'posix'
  if (contents.startsWith(`${WIN32_ADAPTER_MARKER}\n`)) return 'win32'
  return null
}

function meta(contents: string, key: string): string | undefined {
  return new RegExp(`^(?:#|//) ${key}: (.+)$`, 'm').exec(contents)?.[1]
}

function parseTarget(contents: string): HookAdapterTarget | null {
  const kind = meta(contents, 'target-kind')
  const exec = meta(contents, 'target-exec-json')
  if (exec === undefined) return null
  try {
    const execPath: unknown = JSON.parse(exec)
    if (typeof execPath !== 'string') return null
    if (kind === 'npx') {
      const npmCliRaw = meta(contents, 'target-npm-cli-json')
      const specRaw = meta(contents, 'target-spec-json')
      if (npmCliRaw === undefined || specRaw === undefined) return null
      const npmCli: unknown = JSON.parse(npmCliRaw)
      const spec: unknown = JSON.parse(specRaw)
      return typeof npmCli === 'string' && typeof spec === 'string'
        ? { kind: 'npx', execPath, npmCli, spec }
        : null
    }
    const script = meta(contents, 'target-script-json')
    if (script === undefined) return null
    const scriptPath: unknown = JSON.parse(script)
    return typeof scriptPath === 'string' ? { execPath, scriptPath } : null
  } catch {
    return null
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function ensureManagedDirectories(homeDir: string, host: HookHostPlatform): void {
  if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  for (const dir of [path.join(homeDir, '.notifai'), path.join(homeDir, '.notifai', 'bin')]) {
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 })
    const stat = lstatSync(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${dir} is not a regular directory; refusing to install the hook adapter.`)
    }
    if (host === 'posix') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
      if (uid !== undefined && stat.uid !== uid) {
        throw new Error(`${dir} is owned by uid ${stat.uid}, not the current user.`)
      }
      chmodSync(dir, 0o700)
    }
  }
}

function readSafeManagedFile(file: string): { contents: string; mode: number } {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${file} is not a regular file; refusing to replace it.`)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${file} is owned by uid ${stat.uid}, not the current user.`)
  }
  return { contents: readFileSync(file, 'utf8'), mode: stat.mode }
}
