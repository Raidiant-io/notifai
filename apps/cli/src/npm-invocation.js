import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * @typedef {{
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   nodeExecutable?: string,
 *   useActiveNpm?: boolean,
 * }} NpmInvocationOptions
 */

/**
 * The npm JavaScript entry selected by the current npm/npx process, if any.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function activeNpmCli(env) {
  const npmCli = env['npm_execpath']
  return typeof npmCli === 'string' && npmCli !== '' ? npmCli : null
}

/**
 * Resolve npm without making callers reproduce npm.cmd and npm_execpath rules.
 *
 * @param {readonly string[]} args
 * @param {NpmInvocationOptions} [options]
 */
export function npmInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  const active = options.useActiveNpm === false ? null : activeNpmCli(env)
  if (active !== null) {
    return {
      file: nodeExecutable,
      args: [active, ...args],
      options: { windowsHide: true },
    }
  }
  if (platform === 'win32') {
    const bundled = path.join(
      path.dirname(nodeExecutable),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    )
    if (existsSync(bundled)) {
      return {
        file: nodeExecutable,
        args: [bundled, ...args],
        options: { windowsHide: true },
      }
    }
    return { file: 'npm.cmd', args: [...args], options: { windowsHide: true } }
  }
  return { file: 'npm', args: [...args], options: { windowsHide: true } }
}
