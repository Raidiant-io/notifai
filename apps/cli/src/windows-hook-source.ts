/**
 * The Codex process behind a hook on Windows.
 *
 * On macOS and Linux the shell Codex runs a hook through execs the adapter, so
 * the adapter's parent, which it declares as `NOTIFAI_HOOK_SOURCE_PID`, is
 * Codex. Windows has no exec. Codex runs Notifai's command through its session
 * shell, the command starts the system Windows PowerShell, and PowerShell
 * starts the adapter, so the declared parent is a PowerShell that exits with
 * the hook. Every check that binds a card, an attendant or an answer to its
 * Agent Session compares that pid with the Codex process the session recorded,
 * so on Windows the declared pid is replaced by the Codex process above it,
 * once, before any of them runs.
 *
 * The walk proves each step from the process table, never from a name a
 * process gives itself:
 * - the declared process is the exact PowerShell executable Notifai's own hook
 *   command names (`windowsCodexHookShell`);
 * - each parent started no later than its child, so a PID Windows handed to an
 *   unrelated process after the real parent exited is never taken for it;
 * - at most `SHELL_HOPS` shells sit between that PowerShell and `codex.exe`.
 *
 * Anything else leaves the declared pid in place, which no session's Codex
 * process matches: the card stays in the terminal, as it did before.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { windowsProcessDomain } from './cli-execution-domain.js'
import { buildIdentity } from './distribution.js'
import { sameLocalPath } from './local-path.js'
import { windowsCodexHookShell } from './windows-codex-command.js'

/** One row of the Windows process table: who started a process, and when. */
export interface WindowsProcessLink {
  pid: number
  /** Creation time as a FILETIME; compared only with other times from the same reader. */
  created: bigint
  executable: string
  parent: number
}

/** The session shells Codex may run a hook command through. */
const SESSION_SHELLS = new Set(['powershell.exe', 'pwsh.exe', 'cmd.exe'])

/** Shells allowed between Notifai's PowerShell and Codex: Codex's own session shell, once. */
const SHELL_HOPS = 1

/**
 * The Codex pid above a hook whose adapter declared `declared`, or null when
 * the chain is not exactly Codex → session shell → Notifai's PowerShell.
 */
export function windowsCodexHookSource(
  declared: number,
  env: NodeJS.ProcessEnv,
  read: (pid: number) => WindowsProcessLink | null = readWindowsProcessLink,
): number | null {
  const shell = read(declared)
  if (shell === null || !sameLocalPath(shell.executable, windowsCodexHookShell(env), 'win32')) return null
  let child: WindowsProcessLink = shell
  for (let hop = 0; hop <= SHELL_HOPS; hop += 1) {
    const parent: WindowsProcessLink | null = child.parent > 0 ? read(child.parent) : null
    if (parent === null || parent.pid !== child.parent || parent.created > child.created) return null
    const name = path.win32.basename(parent.executable).toLowerCase()
    if (name === 'codex.exe') return parent.pid
    if (!SESSION_SHELLS.has(name)) return null
    child = parent
  }
  return null
}

/**
 * Replace a Windows Codex hook's declared PowerShell with the Codex process
 * above it. A declared pid that is not Notifai's PowerShell (a detached
 * Notifai process that inherited an already-proven pid, or an older adapter)
 * is left as it is; consumers prove what it names themselves.
 */
export function proveWindowsCodexHookSource(
  env: NodeJS.ProcessEnv,
  read: (pid: number) => WindowsProcessLink | null = readWindowsProcessLink,
): void {
  const declared = Number(env['NOTIFAI_HOOK_SOURCE_PID'])
  if (!Number.isInteger(declared) || declared <= 0) return
  const codex = windowsCodexHookSource(declared, env, read)
  if (codex !== null) env['NOTIFAI_HOOK_SOURCE_PID'] = String(codex)
}

/**
 * One process's table row. A native installation asks its launcher, which
 * reads creation time, image and parent from the kernel; a source or npm
 * installation asks CIM through the system PowerShell, about a fifth of a
 * second, once per hook.
 */
export function readWindowsProcessLink(pid: number): WindowsProcessLink | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (buildIdentity() !== null) {
    const domain = windowsProcessDomain(pid)
    return domain === null ? null
      : { pid, created: BigInt(domain.start.slice('windows-filetime:'.length)), executable: domain.executable, parent: domain.parent }
  }
  try {
    const output = execFileSync(windowsCodexHookShell(process.env), ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; ` +
      'if ($p) { "$($p.CreationDate.ToFileTimeUtc())"; "$($p.ParentProcessId)"; $p.ExecutablePath }'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true })
    const [created, parent, executable, extra] = output.trim().split(/\r?\n/)
    if (extra !== undefined || !created || !/^\d+$/.test(created) || !parent || !/^\d+$/.test(parent) ||
        !executable || !path.win32.isAbsolute(executable)) return null
    return { pid, created: BigInt(created), executable, parent: Number(parent) }
  } catch {
    return null
  }
}
