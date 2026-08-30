#!/usr/bin/env node
/** Scan the exact npm tarballs for boundary leaks introduced by generated output. */
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const FORBIDDEN_FILE_PATTERNS = [
  /(?:^|\/)\.env(?:\..*)?$/i,
  /\.p8$/i,
  /\.p12$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.keystore$/i,
  /\.mobileprovision$/i,
  /\.provisionprofile$/i,
  /\.xcconfig$/i,
  /\.entitlements$/i,
  /(?:^|\/)fly\.toml$/i,
  /(?:^|\/)Dockerfile$/i,
  /(?:^|\/)docker-compose[^/]*$/i,
  /\.xcodeproj(?:\/|$)/i,
  /\.xcworkspace(?:\/|$)/i,
]

const FORBIDDEN_CONTENT_PATTERNS = [
  [/@raidiant\/notifai-server/, 'private server package'],
  [/@raidiant\/notifai-contracts/, 'private contracts package'],
  [/@raidiant\/notifai-dashboard/, 'private dashboard package'],
  [new RegExp(['server', 'internal'].join('-')), `private ${['server', 'internal'].join('-')} module`],
  [new RegExp(['test', 'containers'].join(''), 'i'), 'private integration-test stack'],
  [/\b[a-z0-9-]+\.fly\.dev\b/i, 'hosting provider hostname'],
]

const PLACEHOLDER_HOME_NAMES = new Set(['you', 'user', 'example', 'name'])
const HOME_PATH_PATTERNS = [
  /\/Users\/([^/\s"'`\\]+)\//g,
  /\/home\/([^/\s"'`\\]+)\//g,
  /[A-Za-z]:\\Users\\([^\\\s"'`/]+)\\/g,
]

function tarOutput(args, tarball) {
  return execFileSync('tar', [...args, tarball], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

function archiveEntries(tarball) {
  const entries = tarOutput(['-tzf'], tarball)
    .split(/\r?\n/)
    .filter(Boolean)
  if (entries.length === 0) throw new Error(`${tarball}: archive is empty`)
  const unique = new Set(entries)
  if (unique.size !== entries.length) throw new Error(`${tarball}: archive contains duplicate paths`)

  const verbose = tarOutput(['-tvzf'], tarball)
    .split(/\r?\n/)
    .filter(Boolean)
  for (const line of verbose) {
    if (line[0] !== '-' && line[0] !== 'd') {
      throw new Error(`${tarball}: archive contains a link or special entry`)
    }
  }

  for (const entry of entries) {
    const normalized = path.posix.normalize(entry)
    if (
      entry.includes('\\') ||
      path.posix.isAbsolute(entry) ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      (normalized !== 'package' && !normalized.startsWith('package/'))
    ) {
      throw new Error(`${tarball}: unsafe archive path ${entry}`)
    }
  }
  return entries
}

function treeFiles(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) throw new Error(`${absolute}: extracted archive contains a symlink`)
      if (stats.isDirectory()) visit(absolute)
      else if (stats.isFile()) files.push(absolute)
      else throw new Error(`${absolute}: extracted archive contains a special file`)
    }
  }
  visit(root)
  return files.sort()
}

function sourceMapFailures(relative, content) {
  if (!relative.endsWith('.map')) return []
  let sourceMap
  try {
    sourceMap = JSON.parse(content.toString('utf8'))
  } catch {
    return [`${relative}: source map is not valid JSON`]
  }
  const failures = []
  if (Object.prototype.hasOwnProperty.call(sourceMap, 'sourcesContent')) {
    failures.push(`${relative}: source map embeds sourcesContent`)
  }
  if (!Array.isArray(sourceMap.sources)) {
    failures.push(`${relative}: source map has no sources array`)
    return failures
  }
  const sourceRoot = sourceMap.sourceRoot ?? ''
  if (typeof sourceRoot !== 'string') {
    failures.push(`${relative}: source map sourceRoot is not a string`)
    return failures
  }
  for (const source of sourceMap.sources) {
    if (typeof source !== 'string') {
      failures.push(`${relative}: source map contains a non-string source`)
      continue
    }
    const candidate = sourceRoot.length === 0 ? source : path.posix.join(sourceRoot, source)
    if (
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) ||
      path.posix.isAbsolute(candidate) ||
      /^[A-Za-z]:[\\/]/.test(candidate) ||
      candidate.startsWith('\\\\')
    ) {
      failures.push(`${relative}: source map contains an absolute or URL source`)
      continue
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), candidate))
    if (resolved === '..' || resolved.startsWith('../')) {
      failures.push(`${relative}: source map source resolves outside the package`)
    }
  }
  return failures
}

function contentFailures(relative, content) {
  const failures = []
  const text = content.toString('utf8')
  for (const [pattern, label] of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(text)) failures.push(`${relative}: contains ${label}`)
  }
  for (const pattern of HOME_PATH_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const name = match[1].toLowerCase()
      if (!PLACEHOLDER_HOME_NAMES.has(name) && !name.includes('…') && !name.startsWith('<')) {
        failures.push(`${relative}: contains an owner-specific absolute home path`)
        break
      }
    }
  }
  return [...failures, ...sourceMapFailures(relative, content)]
}

function runGitleaks(directory, executable) {
  const result = spawnSync(
    executable,
    ['dir', '--no-banner', '--redact', '--exit-code', '23', '.'],
    { cwd: directory, encoding: 'utf8' },
  )
  if (result.error) throw result.error
  if (result.status === 23) return ['secret scanner found a candidate in the packed artifact']
  if (result.status !== 0) {
    throw new Error(`${executable} packed-artifact scan exited ${result.status}`)
  }
  return []
}

export function scanPackedTarballs({ tarballs, gitleaksBinary }) {
  if (!Array.isArray(tarballs) || tarballs.length === 0) {
    throw new Error('at least one packed tarball is required')
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-packed-boundary-'))
  const failures = []
  let files = 0
  let sourceMaps = 0
  try {
    for (const [index, tarballInput] of tarballs.entries()) {
      const tarball = path.resolve(tarballInput)
      const entries = archiveEntries(tarball)
      for (const entry of entries) {
        for (const pattern of FORBIDDEN_FILE_PATTERNS) {
          if (pattern.test(entry)) failures.push(`${path.basename(tarball)}: forbidden file ${entry}`)
        }
      }

      const destination = path.join(scratch, String(index))
      mkdirSync(destination, { recursive: true })
      execFileSync('tar', ['-xzf', tarball, '-C', destination])
      const packageRoot = path.join(destination, 'package')
      for (const absolute of treeFiles(packageRoot)) {
        files += 1
        const relative = path.relative(packageRoot, absolute).split(path.sep).join('/')
        if (relative.endsWith('.map')) sourceMaps += 1
        failures.push(...contentFailures(relative, readFileSync(absolute)))
      }
      if (gitleaksBinary !== undefined) {
        failures.push(...runGitleaks(packageRoot, gitleaksBinary))
      }
    }
    return { failures: [...new Set(failures)], files, sourceMaps }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function assertPackedTarballs(options) {
  const result = scanPackedTarballs(options)
  if (result.failures.length > 0) {
    throw new Error(`Packed artifact boundary scan FAILED:\n  - ${result.failures.join('\n  - ')}`)
  }
  return result
}

function argvValues(flag) {
  const values = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1] !== undefined) {
      values.push(process.argv[index + 1])
    }
  }
  return values
}

function main() {
  try {
    const result = assertPackedTarballs({
      tarballs: argvValues('--tarball'),
      gitleaksBinary: argvValues('--gitleaks')[0],
    })
    console.log(
      `Packed artifact boundary scan passed (${result.files} files, ${result.sourceMaps} source maps).`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
