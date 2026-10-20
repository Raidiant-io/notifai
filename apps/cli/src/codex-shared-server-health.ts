/** Home-level facts about Codex's shared app-server for `doctor`.
 *
 * A device answer can close a Codex question form only through the server that
 * owns the session's thread. Whether one session joined such a server is fixed
 * when that session launches, so only its card hook or `ask` can say it for a session. This
 * reports what is true of the effective CODEX_HOME, and never starts, stops or
 * updates a server: those choices, and their costs, belong to the User.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { parse as parseToml } from 'smol-toml'
import { codexHome } from './codex-wake.js'
import type { ReadinessState } from './readiness.js'

const execute = promisify(execFile)

export const CODEX_SHARED_SERVER_STATE_ID = 'hooks-codex-shared-server'
const TITLE = 'Codex question cards'

export interface CodexDaemonVersion {
  status?: string
  managedCodexVersion?: string
  appServerVersion?: string
  cliVersion?: string
}

/** Null when Codex cannot be asked at all; otherwise its version report. */
export type ReadCodexDaemonVersion = (env: NodeJS.ProcessEnv) => Promise<CodexDaemonVersion | 'not-running' | null>

const readCodexDaemonVersion: ReadCodexDaemonVersion = async env => {
  try {
    const { stdout } = await execute('codex', ['app-server', 'daemon', 'version'], { env, timeout: 5_000, maxBuffer: 16_384 })
    const parsed = JSON.parse(stdout) as CodexDaemonVersion
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    // A missing executable is not a statement about the server.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    // `version` exits non-zero when no server answers on the control socket.
    return 'not-running'
  }
}

/** Codex keeps its updater's socket in CODEX_HOME. A path longer than the
 * platform's sun_path cannot bind (openai/codex#51153), so no updater runs. */
function updaterCannotRun(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return false
  const socket = path.join(codexHome(env), 'app-server-daemon', 'daemon-updater.sock')
  return Buffer.byteLength(socket, 'utf8') > (platform === 'darwin' ? 103 : 107)
}

function autoStartDisabled(env: NodeJS.ProcessEnv): boolean {
  try {
    const config = parseToml(readFileSync(path.join(codexHome(env), 'config.toml'), 'utf8')) as {
      features?: { daemon_auto_start?: unknown }
    }
    return config.features?.daemon_auto_start === false
  } catch {
    return false
  }
}

export async function codexSharedServerState(
  env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform,
  read: ReadCodexDaemonVersion = readCodexDaemonVersion,
): Promise<ReadinessState | null> {
  const version = await read(env)
  if (version === null) return null
  const running = version !== 'not-running' && version.status === 'running'
  if (!running) {
    // An expected limit, not a fault: questions still work, as plain ones,
    // so this reads as ready and nothing offers to change it.
    const disabled = autoStartDisabled(env)
    return {
      id: CODEX_SHARED_SERVER_STATE_ID,
      title: TITLE,
      status: 'ready',
      detail: 'questions work. ' + (disabled
        ? 'This Codex home turns off Codex\'s shared server (`daemon_auto_start = false` in its config.toml), so a question that goes to your phone is asked as a plain question instead of a card your phone can close. Nothing to fix. For cards, remove that line and start a new Codex session'
        : 'No shared Codex server is running for this Codex home, so a question that goes to your phone is asked as a plain question instead of a card your phone can close. Nothing to fix. For cards, start a new Codex session without `--no-daemon`'),
      technical: { shared_server_running: false, daemon_auto_start_disabled: disabled },
    }
  }
  const server = version.appServerVersion ?? version.managedCodexVersion
  const cli = version.cliVersion
  if (server !== undefined && cli !== undefined && server !== cli) {
    const stuck = updaterCannotRun(env, platform)
    return {
      id: CODEX_SHARED_SERVER_STATE_ID,
      title: TITLE,
      status: 'optional-gap',
      detail: `the shared Codex app-server for this CODEX_HOME runs ${server}, but the installed Codex CLI is ${cli}` +
        (stuck ? '. Codex\'s updater cannot run in a CODEX_HOME this deep, so it will not catch up on its own' : ''),
      technical: { app_server_version: server, cli_version: cli, updater_socket_path_too_long: stuck },
      remedy: {
        by: 'user-here',
        summary: 'move the shared Codex app-server to the installed CLI version when no session depends on it; this restarts it and interrupts attached sessions',
        // --from-cli pins the package, which is right only where updates cannot run.
        command: stuck ? 'codex app-server daemon update --from-cli --yes' : 'codex app-server daemon update --yes',
      },
    }
  }
  return {
    id: CODEX_SHARED_SERVER_STATE_ID,
    title: TITLE,
    status: 'ready',
    detail: `a shared Codex server (${server ?? 'version unknown'}) is running for this Codex home, so sessions that joined it show question cards your phone can close`,
  }
}
