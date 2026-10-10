import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIdentity } from './distribution.js'
import { accountHome } from './platform.js'
import { canonicalPath, sameLocalPath } from './local-path.js'
import { installedRuntime } from './local-continuity.js'
import { assertNativeLaunchAllowed } from './native-uninstall-barrier.js'

/** A durable reference names local content, never an arbitrary executable path. */
export interface RuntimeBuildReference { installation_id: string; build: string }
export function validRuntimeBuildReference(value: unknown): value is RuntimeBuildReference {
  const reference = value as Partial<RuntimeBuildReference> | null
  return reference !== null && typeof reference === 'object' &&
    typeof reference.installation_id === 'string' && /^[a-f0-9-]{36}$/.test(reference.installation_id) &&
    typeof reference.build === 'string' && /^[a-f0-9]{64}$/.test(reference.build)
}

/** The launcher already admitted this executable under the managed tree. Pin
 * descendants to that immutable directory, including when active.json changes.
 * This is local identity, not a replacement for distribution authentication. */
export function currentRuntimeBuild(env: NodeJS.ProcessEnv = process.env): RuntimeBuildReference | null {
  const identity = buildIdentity()
  if (identity === null) return null // Source/development execution.
  if (identity.sourceDirty !== false) throw new Error('Resident work requires a verified managed build')
  const root = path.join(accountHome(env), '.notifai')
  const executable = canonicalPath(process.execPath), directory = path.dirname(executable)
  const build = path.basename(directory)
  const extension = process.platform === 'win32' ? '.exe' : ''
  if (!/^[a-f0-9]{64}$/.test(build) || !sameLocalPath(path.dirname(directory), path.join(root, 'versions')) ||
      path.basename(executable).toLowerCase() !== `notifai-runtime${extension}`) throw new Error('Install Notifai before starting resident work')
  const record = JSON.parse(readFileSync(path.join(root, 'install.json'), 'utf8')) as { id?: unknown; owner?: unknown; target?: unknown }
  const reference = { installation_id: record.id, build }
  if (record.owner !== 'notifai' || installedRuntime(record)?.target !== identity.target || !validRuntimeBuildReference(reference)) {
    throw new Error('The running build does not belong to this installation')
  }
  return reference
}

/** Deliberate detached launch only. Persist the caller's existing owner record
 * before starting a child. No install lock, mutable PATH command, or shell. */
export function launchSelf(args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv;
  retain: (reference: RuntimeBuildReference | null) => void }): { pid: number } {
  const reference = currentRuntimeBuild(options.env)
  assertNativeLaunchAllowed(options.env)
  const env = { ...options.env }
  for (const name of Object.keys(env)) {
    if (/^(BUN_|JSC_|DYLD_)/i.test(name) || ['LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(name)) delete env[name]
  }
  const extension = process.platform === 'win32' ? '.exe' : ''
  const executable = reference ? path.join(accountHome(env), '.notifai', 'versions', reference.build, `notifai${extension}`) : process.execPath
  const argv = reference ? [...args] : [fileURLToPath(new URL('./main.js', import.meta.url)), ...args]
  options.retain(reference)
  assertNativeLaunchAllowed(options.env)
  if (reference && process.platform === 'win32') {
    const output = execFileSync(executable, ['--internal-detach', ...argv], { cwd: options.cwd, env,
      encoding: 'utf8', timeout: 20_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const pid = Number(output.trim())
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Detached owner did not return a process identity')
    return { pid }
  }
  const child = spawn(executable, reference ? ['--internal-detach', ...argv] : argv,
    { cwd: options.cwd, env, detached: true, stdio: 'ignore', windowsHide: true })
  child.once('error', () => undefined)
  child.unref()
  if (child.pid === undefined) throw new Error('Detached owner could not start')
  return { pid: child.pid }
}
