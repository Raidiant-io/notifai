import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { sameLocalPath } from './local-path.js'
import { npmAdapterPosixAccess, type NpmAdapterAccessCheck, type VerifiedNpmAdapter } from './npm-adapter-verification.js'

export interface NpmAdapterRoute {
  kind: 'global' | 'npx' | 'local' | 'direct'
  command: string
  directory: string
  global_prefix: string | null
  temporary_bin: string | null
}

/** Exact Node-shebang wrapper templates from npm cmd-shim 8.0.0. A target
 * substring alone never admits a wrapper with additional executable code.
 * cmd-shim's ISC attribution accompanies the generated npm artifact. */
export function npmShim(relative: string, extension: string): string {
  const target = relative.replaceAll('\\', '/')
  if (extension === '.cmd') return [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target.replaceAll('/', '\\')}" %*`, '',
  ].join('\n')
  if (extension === '.ps1') return [
    '#!/usr/bin/env pwsh', '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent', '', '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {', '  # Fix case when both the Windows and Linux builds of Node',
    '  # are installed in the same directory', '  $exe=".exe"', '}', '$ret=0', 'if (Test-Path "$basedir/node$exe") {',
    '  # Support pipeline input', '  if ($MyInvocation.ExpectingInput) {', `    $input | & "$basedir/node$exe"  "$basedir/${target}" $args`,
    '  } else {', `    & "$basedir/node$exe"  "$basedir/${target}" $args`, '  }', '  $ret=$LASTEXITCODE', '} else {',
    '  # Support pipeline input', '  if ($MyInvocation.ExpectingInput) {', `    $input | & "node$exe"  "$basedir/${target}" $args`,
    '  } else {', `    & "node$exe"  "$basedir/${target}" $args`, '  }', '  $ret=$LASTEXITCODE', '}', 'exit $ret', '',
  ].join('\n')
  return [
    '#!/bin/sh', 'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")', '', 'case `uname` in', '    *CYGWIN*|*MINGW*|*MSYS*)',
    '        if command -v cygpath > /dev/null 2>&1; then', '            basedir=`cygpath -w "$basedir"`', '        fi', '    ;;', 'esac', '',
    'if [ -x "$basedir/node" ]; then', `  exec "$basedir/node"  "$basedir/${target}" "$@"`, 'else ',
    `  exec node  "$basedir/${target}" "$@"`, 'fi', '',
  ].join('\n')
}

function placement(proof: VerifiedNpmAdapter, platform: NodeJS.Platform): Omit<NpmAdapterRoute, 'command'> | null {
  const scope = path.dirname(proof.directory), modules = path.dirname(scope), base = path.dirname(modules)
  if (path.basename(proof.directory) !== 'notifai' || path.basename(scope) !== '@raidiant' || path.basename(modules) !== 'node_modules') return null
  if (path.basename(path.dirname(base)) === '_npx') {
    return { kind: 'npx', directory: path.join(modules, '.bin'), global_prefix: null, temporary_bin: path.join(modules, '.bin') }
  }
  if (platform === 'win32') return { kind: 'global', directory: base, global_prefix: base, temporary_bin: null }
  if (path.basename(base) === 'lib') {
    const prefix = path.dirname(base)
    return { kind: 'global', directory: path.join(prefix, 'bin'), global_prefix: prefix, temporary_bin: null }
  }
  return { kind: 'local', directory: path.join(modules, '.bin'), global_prefix: null, temporary_bin: null }
}

/** Native inspection and the npm child launch share this non-executing proof.
 * Unknown, changed, foreign-owned or dangling shims remain unknown routes. */
export function inspectNpmAdapterRoute(command: string, proof: VerifiedNpmAdapter,
  options: { platform?: NodeJS.Platform; checkAccess?: NpmAdapterAccessCheck } = {}): NpmAdapterRoute | null {
  const platform = options.platform ?? process.platform, access = options.checkAccess ?? npmAdapterPosixAccess
  try {
    const candidate = path.resolve(command), root = path.resolve(proof.directory)
    if (sameLocalPath(candidate, proof.executable, platform) && !lstatSync(candidate).isSymbolicLink()) {
      access([{ file: candidate, directory: false }])
      return { kind: 'direct', command: candidate, directory: path.dirname(candidate), global_prefix: null, temporary_bin: null }
    }
    const route = placement(proof, platform)
    if (!route || !sameLocalPath(path.dirname(candidate), route.directory, platform)) return null
    const name = path.basename(candidate).toLowerCase()
    if (!(platform === 'win32' ? ['notifai', 'notifai.cmd', 'notifai.ps1'] : ['notifai']).includes(name)) return null
    // Check the package-to-prefix/cache path and command directory, including
    // intermediate scope/modules/lib directories, before trusting shim bytes.
    const stop = route.global_prefix ?? (route.kind === 'npx' ? path.dirname(path.dirname(path.dirname(route.directory))) : path.dirname(path.dirname(route.directory)))
    const directories = new Set<string>()
    for (const start of [root, route.directory]) {
      let current = start
      for (let depth = 0; depth < 16; depth++) {
        const stat = lstatSync(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null
        directories.add(current)
        if (sameLocalPath(current, stop, platform)) break
        const parent = path.dirname(current)
        if (parent === current || depth === 15) return null
        current = parent
      }
    }
    const stat = lstatSync(candidate)
    if (platform !== 'win32') {
      // POSIX symlink modes are not access control. Its owner and containing
      // directory, then the exact real target, establish this npm route.
      if (!stat.isSymbolicLink() || !process.getuid || stat.uid !== process.getuid() ||
          !sameLocalPath(realpathSync(candidate), proof.executable, platform)) return null
    } else {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return null
      const relative = path.relative(route.directory, proof.executable)
      const bytes = readFileSync(candidate, 'utf8').replaceAll('\r\n', '\n')
      if (bytes !== npmShim(relative, path.extname(name))) return null
    }
    access([...directories].map(file => ({ file, directory: true })).concat(
      platform === 'win32' ? [{ file: candidate, directory: false }] : []))
    return { ...route, command: candidate }
  } catch { return null }
}

/** Drop only a positively verified NPX cache's temporary insertion. In
 * particular a global bin and every unrelated or unknown PATH entry remain. */
export function environmentForVerifiedAdapter(proof: VerifiedNpmAdapter, env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; checkAccess?: NpmAdapterAccessCheck } = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform, route = placement(proof, platform)
  if (!route?.temporary_bin) return env
  const names = platform === 'win32' ? ['notifai', 'notifai.cmd', 'notifai.ps1'] : ['notifai']
  if (!names.every(name => inspectNpmAdapterRoute(path.join(route.directory, name), proof, options)?.kind === 'npx')) return env
  const result = { ...env }, delimiter = platform === 'win32' ? ';' : ':'
  for (const key of Object.keys(env).filter(name => platform === 'win32' ? name.toLowerCase() === 'path' : name === 'PATH')) {
    result[key] = (env[key] ?? '').split(delimiter).filter(entry => entry === '' || !sameLocalPath(entry, route.directory, platform)).join(delimiter)
  }
  return result
}

export function adapterRoutesOnPath(proof: VerifiedNpmAdapter, env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; checkAccess?: NpmAdapterAccessCheck } = {}): NpmAdapterRoute[] {
  const platform = options.platform ?? process.platform, result: NpmAdapterRoute[] = []
  const raw = platform === 'win32' ? env['Path'] ?? env['PATH'] ?? '' : env['PATH'] ?? ''
  for (const directory of raw.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const name of platform === 'win32' ? ['notifai', 'notifai.cmd', 'notifai.ps1'] : ['notifai']) {
      const route = inspectNpmAdapterRoute(path.join(directory, name), proof, options)
      if (route) result.push(route)
    }
  }
  return result
}
