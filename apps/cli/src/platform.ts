import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * How this process should launch one child. Tests inspect the plan instead of
 * opening a browser or running npx; production hands it to `spawn`.
 */
export interface ProcessLaunch {
  file: string
  args: string[]
  options: SpawnOptions
}

/** Drive letter or UNC. MSYS `/c/Users/…` is not a Windows account home. */
export function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * The account home used for Notifai's own defaults.
 *
 * On Windows, Git Bash and MSYS overwrite `HOME` with a POSIX path that is not
 * a usable NTFS root. Those values are ignored; a Windows-absolute
 * `USERPROFILE` or `os.homedir()` wins. A Windows-absolute `HOME` is still
 * honoured. POSIX keeps `HOME` as the override it has always been.
 */
export function accountHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const home = env['HOME']
    if (typeof home === 'string' && isWindowsAbsolute(home)) return home
    const profile = env['USERPROFILE']
    if (typeof profile === 'string' && isWindowsAbsolute(profile)) return profile
    return os.homedir()
  }
  const home = env['HOME']
  if (typeof home === 'string' && home !== '') return home
  return os.homedir()
}

/**
 * Directory that contains the `notifai/` configuration folder.
 *
 * An explicit `XDG_CONFIG_HOME` always wins, including on Windows. Otherwise
 * Windows uses `%APPDATA%` and POSIX uses `~/.config`.
 */
export function configHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const xdg = env['XDG_CONFIG_HOME']
  if (typeof xdg === 'string' && xdg !== '') return xdg
  if (platform === 'win32') {
    const appdata = env['APPDATA']
    if (typeof appdata === 'string' && appdata !== '') return appdata
  }
  return path.join(accountHome(env, platform), '.config')
}

/**
 * Directory that contains the `notifai/` machine-local state folder.
 *
 * An explicit `XDG_STATE_HOME` always wins. Otherwise Windows uses
 * `%LOCALAPPDATA%` and POSIX uses `~/.local/state`.
 */
export function stateHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const xdg = env['XDG_STATE_HOME']
  if (typeof xdg === 'string' && xdg !== '') return xdg
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA']
    if (typeof local === 'string' && local !== '') return local
  }
  return path.join(accountHome(env, platform), '.local', 'state')
}

/**
 * Open a pairing or support URL.
 *
 * Windows goes through `rundll32` so the URL is one CreateProcess argument and
 * `cmd` never reparses `?a=1&b=2`. `windowsHide` keeps the helper from flashing
 * a console. macOS and Linux stay best-effort `open` / `xdg-open`.
 */
export function urlOpenLaunch(
  url: string,
  platform: NodeJS.Platform = process.platform,
): ProcessLaunch {
  if (platform === 'darwin') {
    return { file: 'open', args: [url], options: { stdio: 'ignore', detached: true } }
  }
  if (platform === 'win32') {
    return {
      file: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
      options: { stdio: 'ignore', detached: true, windowsHide: true },
    }
  }
  return { file: 'xdg-open', args: [url], options: { stdio: 'ignore', detached: true } }
}

/** Best-effort browser open. Failure is silent: the URL is printed either way. */
export function openUrl(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    const launch = urlOpenLaunch(url, platform)
    spawn(launch.file, launch.args, launch.options).unref()
  } catch {
    // The caller already printed the URL.
  }
}

/**
 * Quote one cmd.exe argument so it cannot start a second command.
 *
 * `%` expands even inside quotes, so it is doubled. Quotes themselves are
 * doubled. Everything else is inert once quoted, including `& | > < ^`.
 */
export function quoteCmdArgument(value: string): string {
  return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`
}

/**
 * A single `/c` argument for `cmd /d /s /c`.
 *
 * `/s` strips the first and last quote when both ends are quotes, so the
 * payload is wrapped once more around the already-quoted argv. What cmd then
 * runs is `"npx.cmd" "-y" …` with no unquoted metacharacters.
 */
export function cmdScript(command: string, args: readonly string[]): string {
  return `"${[command, ...args].map(quoteCmdArgument).join(' ')}"`
}

/**
 * Launch `npx` without making its resolution depend on the target project.
 *
 * A standard Windows Node installation carries npm's JavaScript npx entrypoint
 * beside node.exe. Invoking that file directly survives an isolated cwd and
 * avoids cmd parsing. Non-standard installations retain the safely quoted
 * `.cmd` fallback; POSIX can execute `npx` directly.
 */
export function npxLaunch(
  args: readonly string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    stdio?: SpawnOptions['stdio']
    nodeExecutable?: string
    npxCliPath?: string | null
  },
): ProcessLaunch {
  const platform = options.platform ?? process.platform
  const stdio = options.stdio ?? 'inherit'
  if (platform === 'win32') {
    const nodeExecutable = options.nodeExecutable ?? process.execPath
    const detectedNpxCli = path.join(
      path.dirname(nodeExecutable),
      'node_modules',
      'npm',
      'bin',
      'npx-cli.js',
    )
    const npxCli = options.npxCliPath === undefined
      ? (existsSync(detectedNpxCli) ? detectedNpxCli : null)
      : options.npxCliPath
    if (npxCli !== null) {
      return {
        file: nodeExecutable,
        args: [npxCli, ...args],
        options: {
          cwd: options.cwd,
          env: options.env,
          stdio,
          windowsHide: true,
        },
      }
    }
    return {
      file: options.env['ComSpec'] && options.env['ComSpec'] !== '' ? options.env['ComSpec'] : 'cmd.exe',
      args: ['/d', '/s', '/v:off', '/c', cmdScript('npx.cmd', args)],
      options: {
        cwd: options.cwd,
        env: options.env,
        stdio,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    }
  }
  return {
    file: 'npx',
    args: [...args],
    options: { cwd: options.cwd, env: options.env, stdio },
  }
}
