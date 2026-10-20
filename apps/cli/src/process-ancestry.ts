/**
 * The chain of processes from this one up to the system's first process.
 *
 * A harness exports its session markers into every process it starts, and
 * anything those processes start keeps them: a tmux server or an editor
 * launched from an agent's shell outlives the command that started it and
 * hands the markers to every shell opened later. Only the process tree says
 * whether a caller really runs inside the session its markers name.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface AncestorProcess {
  pid: number
  /** Executable name without its directory (Linux keeps 15 characters). */
  name: string
}

/** Enough for any real nesting of shells, sandboxes and harnesses. */
const MAX_DEPTH = 64

/**
 * This process and its ancestors, nearest first; null when the tree cannot be
 * read here (Windows, or no `ps` or `/proc`).
 */
export function processAncestry(
  pid: number = process.pid,
  platform: NodeJS.Platform = process.platform,
): AncestorProcess[] | null {
  if (platform === 'linux') return linuxAncestry(pid)
  if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') return psAncestry(pid)
  return null
}

function linuxAncestry(start: number): AncestorProcess[] | null {
  const chain: AncestorProcess[] = []
  let pid = start
  while (pid > 0 && chain.length < MAX_DEPTH) {
    let stat: string
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch {
      return chain.length === 0 ? null : chain
    }
    // `pid (comm) state ppid …`; comm may itself hold spaces and parentheses.
    const open = stat.indexOf('(')
    const close = stat.lastIndexOf(')')
    if (open < 0 || close < open) return chain.length === 0 ? null : chain
    chain.push({ pid, name: stat.slice(open + 1, close) })
    const ppid = Number(stat.slice(close + 2).split(' ')[1])
    if (!Number.isInteger(ppid) || ppid === pid) break
    pid = ppid
  }
  return chain
}

function psAncestry(start: number): AncestorProcess[] | null {
  let output: string
  try {
    output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    return null
  }
  const table = new Map<number, { ppid: number; name: string }>()
  for (const line of output.split('\n')) {
    const matched = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (matched === null) continue
    const name = matched[3]!.trim()
    table.set(Number(matched[1]), { ppid: Number(matched[2]), name: path.basename(name) })
  }
  if (!table.has(start)) return null
  const chain: AncestorProcess[] = []
  let pid = start
  while (chain.length < MAX_DEPTH) {
    const entry = table.get(pid)
    if (entry === undefined) break
    chain.push({ pid, name: entry.name })
    if (entry.ppid === pid || entry.ppid <= 0) break
    pid = entry.ppid
  }
  return chain
}
