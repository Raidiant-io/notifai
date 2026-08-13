#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

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
) {
  if (platform !== 'win32') return { file: command, args: [...args], options: {} }
  const home = env.PNPM_HOME
  if (command === 'pnpm' && typeof home === 'string' && home !== '') {
    const installRoot = path.dirname(home)
    return {
      file: process.execPath,
      args: [path.join(installRoot, 'pnpm', 'bin', 'pnpm.cjs'), ...args],
      options: { windowsHide: true },
    }
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
