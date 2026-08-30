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
 * Resolve npm's JavaScript npx entry point when this Windows Node installation
 * exposes it. Invoking that file with the current Node runtime avoids the
 * cwd-sensitive relative paths embedded in some npx.cmd shims.
 */
export function windowsNpxCli(
  nodeExecutable: string = process.execPath,
): string | null {
  const bundledWithNode = path.join(
    path.dirname(nodeExecutable),
    'node_modules',
    'npm',
    'bin',
    'npx-cli.js',
  )
  return existsSync(bundledWithNode) ? bundledWithNode : null
}

/**
 * Launch `npx` without making its resolution depend on the target project.
 *
 * Prefer npm's JavaScript entry point, which avoids both CreateProcess's
 * inability to run `.cmd` files and shims whose relative paths depend on the
 * working directory. A nonstandard Windows Node layout fails closed instead
 * of executing an environment-selected shell or command shim; POSIX can
 * execute `npx` directly without a shell.
 */
export function npxLaunch(
  args: readonly string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    nodeExecutable?: string
    platform?: NodeJS.Platform
    stdio?: SpawnOptions['stdio']
  },
): ProcessLaunch {
  const platform = options.platform ?? process.platform
  const stdio = options.stdio ?? 'inherit'
  if (platform === 'win32') {
    const nodeExecutable = options.nodeExecutable ?? process.execPath
    const npxCli = windowsNpxCli(nodeExecutable)
    if (npxCli === null) throw new Error('the current Windows Node installation does not include npm npx-cli.js')
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
    file: 'npx',
    args: [...args],
    options: { cwd: options.cwd, env: options.env, stdio },
  }
}
