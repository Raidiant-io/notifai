#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { npmInvocation } from '../apps/cli/src/npm-invocation.js'

/** Absolute directory containing this repository's scripts. */
export const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = path.resolve(scriptsDirectory, '..')

/**
 * Resolve a package-manager command without asking Node to execute a `.cmd`
 * shim directly. Windows package-manager shims are JavaScript files beside the
 * `.cmd` wrappers, so invoke the current Node runtime on that stable companion
 * instead of reparsing a command line through cmd.exe.
 */
export function commandInvocation(
  command,
  args,
  platform = process.platform,
  env = process.env,
  nodeExecutable = process.execPath,
) {
  if (platform !== 'win32') return { file: command, args: [...args], options: {} }
  const executable = env.npm_execpath
  if (command === 'pnpm' && typeof executable === 'string' && executable !== '') {
    return {
      file: process.execPath,
      args: [executable, ...args],
      options: { windowsHide: true },
    }
  }
  const home = env.PNPM_HOME
  if (command === 'pnpm' && typeof home === 'string' && home !== '') {
    const shim = path.join(home, 'pnpm.cmd')
    const match = /"([^"]*pnpm\.cjs)"/.exec(readFileSync(shim, 'utf8'))
    if (match !== null) {
      const relative = match[1].replace(/^%~dp0[\\/]/i, '').split(/[\\/]+/).join(path.sep)
      return {
        file: process.execPath,
        args: [path.resolve(home, relative), ...args],
        options: { windowsHide: true },
      }
    }
  }
  if (command === 'npm') {
    return npmInvocation(args, {
      platform,
      env,
      nodeExecutable,
      // Release scripts run under pnpm, whose npm_execpath names pnpm rather
      // than npm. Resolve npm from Node instead of invoking the parent manager.
      useActiveNpm: false,
    })
  }
  return { file: `${command}.cmd`, args: [...args], options: { windowsHide: true } }
}

export function execCommand(command, args, options = {}) {
  const invocation = commandInvocation(command, args)
  return execFileSync(invocation.file, invocation.args, {
    ...options,
    ...invocation.options,
  })
}
