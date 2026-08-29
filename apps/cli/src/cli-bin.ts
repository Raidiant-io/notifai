import { accessSync, constants, existsSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { ReadinessState } from './readiness.js'

const POSIX_NAMES = ['notifai']
const WINDOWS_NAMES = ['notifai.cmd', 'notifai.exe', 'notifai']

export function pathNotifaiEntries(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const raw = platform === 'win32' ? (env['Path'] ?? env['PATH'] ?? '') : (env['PATH'] ?? '')
  const delimiter = platform === 'win32' ? ';' : ':'
  const names = platform === 'win32' ? WINDOWS_NAMES : POSIX_NAMES
  const found: string[] = []
  for (const directory of raw.split(delimiter)) {
    if (directory === '') continue
    for (const name of names) {
      const candidate = path.join(directory, name)
      if (!existsSync(candidate)) continue
      if (!found.includes(candidate)) found.push(candidate)
    }
  }
  return found
}

export function isExecutablePath(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!existsSync(file)) return false
  if (platform === 'win32') return true
  try {
    const target = lstatSync(file).isSymbolicLink() ? realpathSync(file) : file
    accessSync(target, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function cliBinReadiness(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ReadinessState {
  const entries = pathNotifaiEntries(env, platform)
  const broken = entries.find((file) => !isExecutablePath(file, platform))
  if (broken !== undefined) {
    return {
      id: 'cli-bin',
      title: 'notifai command',
      status: 'gap',
      detail: `${broken} is on PATH but is not executable`,
      remedy: {
        by: 'user-here',
        summary: 'repair the global notifai command so it can run',
        command: 'npm install -g @raidiant/notifai',
      },
    }
  }
  // A global install that landed outside PATH used to report `ready` with
  // "this process can run" — which is true of the running process and false of
  // every instruction it goes on to print. Hooks embed absolute paths, so
  // nothing visibly breaks until the reader types `notifai` themselves.
  //
  // Not a blocker: this process is already running, so the whole setup —
  // pairing, the app, the delivery proof — still completes. It is the later
  // `notifai …` lines that will not be found, and saying so is the fix.
  if (entries[0] === undefined) {
    return {
      id: 'cli-bin',
      title: 'notifai command',
      status: 'optional-gap',
      detail:
        'no `notifai` on PATH — this process runs, but a typed `notifai …` command will not be found',
      remedy: {
        by: 'user-here',
        summary: 'install notifai globally so the command is on your PATH',
        command: 'npm install -g @raidiant/notifai',
      },
    }
  }
  return {
    id: 'cli-bin',
    title: 'notifai command',
    status: 'ready',
    detail: `${entries[0]} is executable`,
  }
}
