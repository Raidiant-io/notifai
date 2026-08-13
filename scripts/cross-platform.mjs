#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** Absolute directory containing this repository's scripts. */
export const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = path.resolve(scriptsDirectory, '..')

function quoteCmdArgument(value) {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`
}

/**
 * Resolve a package-manager command without asking Node to execute a `.cmd`
 * shim directly. Windows CreateProcess cannot launch those shims, so cmd.exe
 * receives one fully quoted command string; POSIX keeps direct argv execution.
 */
export function commandInvocation(
  command,
  args,
  platform = process.platform,
  env = process.env,
) {
  if (platform !== 'win32') return { file: command, args: [...args], options: {} }
  const script = `"${[`${command}.cmd`, ...args].map(quoteCmdArgument).join(' ')}"`
  return {
    file: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', script],
    options: { windowsHide: true, windowsVerbatimArguments: true },
  }
}

export function execCommand(command, args, options = {}) {
  const invocation = commandInvocation(command, args)
  return execFileSync(invocation.file, invocation.args, {
    ...options,
    ...invocation.options,
  })
}
