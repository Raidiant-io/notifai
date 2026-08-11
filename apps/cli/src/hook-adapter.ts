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
import { atomicWriteFileSync, withFileLockSync } from './atomic-file.js'

const ADAPTER_MARKER = '# notifai managed hook adapter'
const ADAPTER_VERSION = 1

export interface HookAdapterTarget {
  execPath: string
  scriptPath: string
}

export interface HookAdapterInspection {
  path: string
  target: HookAdapterTarget | null
  problems: string[]
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
): { path: string; changed: boolean } {
  assertUsableTarget(target)
  const file = hookAdapterPath(homeDir)
  ensureManagedDirectories(homeDir ?? os.userInfo().homedir)
  const source = hookAdapterSource(target)
  return withFileLockSync(file, () => {
    const existing = existsSync(file) ? readSafeManagedFile(file) : null
    const changed =
      existing === null || existing.contents !== source || (existing.mode & 0o777) !== 0o700
    if (changed) {
      atomicWriteFileSync(file, source, {
        mode: 0o700,
        preserveMode: false,
        requireCurrentUserOwner: true,
      })
    }
    return { path: file, changed }
  })
}

function assertUsableTarget(target: HookAdapterTarget): void {
  let exec
  try {
    exec = statSync(target.execPath)
  } catch {
    throw new Error(`Hook adapter runtime ${target.execPath} does not exist.`)
  }
  if (!exec.isFile() || (exec.mode & 0o111) === 0) {
    throw new Error(`Hook adapter runtime ${target.execPath} is not executable.`)
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
): HookAdapterInspection {
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
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && stat.uid !== uid) {
    problems.push(`${file} is owned by uid ${stat.uid}, not the current user`)
  }
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700) {
    problems.push(`${file} permissions are ${(stat.mode & 0o777).toString(8)}, expected 700`)
  }

  const contents = readFileSync(file, 'utf8')
  if (!contents.startsWith(`#!/bin/sh\n${ADAPTER_MARKER}\n`)) {
    problems.push(`${file} has no managed adapter marker`)
  }
  const version = Number(/^# adapter-version: (\d+)$/m.exec(contents)?.[1] ?? Number.NaN)
  if (version !== ADAPTER_VERSION) problems.push(`${file} uses obsolete adapter version ${version}`)
  const target = parseTarget(contents)
  if (target === null) {
    problems.push(`${file} has malformed target metadata`)
  } else {
    try {
      const exec = statSync(target.execPath)
      if (!exec.isFile() || (exec.mode & 0o111) === 0) {
        problems.push(`registered runtime ${target.execPath} is not executable`)
      }
    } catch {
      problems.push(`registered runtime ${target.execPath} is missing`)
    }
    try {
      if (!statSync(target.scriptPath).isFile()) {
        problems.push(`registered CLI ${target.scriptPath} is not a regular file`)
      }
    } catch {
      problems.push(`registered CLI ${target.scriptPath} is missing`)
    }
  }
  return { path: file, target, problems }
}

function hookAdapterSource(target: HookAdapterTarget): string {
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

function parseTarget(contents: string): HookAdapterTarget | null {
  const exec = /^# target-exec-json: (.+)$/m.exec(contents)?.[1]
  const script = /^# target-script-json: (.+)$/m.exec(contents)?.[1]
  if (exec === undefined || script === undefined) return null
  try {
    const execPath: unknown = JSON.parse(exec)
    const scriptPath: unknown = JSON.parse(script)
    return typeof execPath === 'string' && typeof scriptPath === 'string'
      ? { execPath, scriptPath }
      : null
  } catch {
    return null
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function ensureManagedDirectories(homeDir: string): void {
  if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  for (const dir of [path.join(homeDir, '.notifai'), path.join(homeDir, '.notifai', 'bin')]) {
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 })
    const stat = lstatSync(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${dir} is not a regular directory; refusing to install the hook adapter.`)
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`${dir} is owned by uid ${stat.uid}, not the current user.`)
    }
    chmodSync(dir, 0o700)
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
