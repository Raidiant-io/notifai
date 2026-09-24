#!/usr/bin/env node
/** Reject this machine's absolute home path in the public tree or Git history. */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './cross-platform.mjs'

const MAX_OUTPUT = 512 * 1024 * 1024

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT,
    ...options,
  })
}

function homeForms(home) {
  const canonical = home.replace(/[\\/]+$/u, '')
  if (canonical.length < 4 || canonical === '/') throw new Error('machine home path is not usable')
  const forms = new Set([canonical, canonical.replaceAll('\\', '/'), canonical.replaceAll('/', '\\')])
  return [...forms].map(value => value.toLowerCase())
}

function containsHome(content, forms) {
  const text = content.toString('utf8').toLowerCase()
  return forms.some(form => {
    let at = text.indexOf(form)
    while (at !== -1) {
      const after = text[at + form.length]
      if (after === undefined || /[\s/\\"'`\]}),;]/u.test(after)) return true
      at = text.indexOf(form, at + 1)
    }
    return false
  })
}

function historyBlobs(repo) {
  const objects = git(repo, ['rev-list', '--objects', '--all', 'HEAD'])
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(0, 40))
  if (objects.length === 0) throw new Error('Git history has no objects to scan')
  const ids = [...new Set(objects)]
  const result = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: `${ids.join('\n')}\n`,
    encoding: null,
    maxBuffer: MAX_OUTPUT,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Git object scan failed')
  const blobs = []
  let offset = 0
  for (const expected of ids) {
    const end = result.stdout.indexOf(0x0a, offset)
    if (end === -1) throw new Error('Git object response was truncated')
    const [sha, type, sizeText] = result.stdout.subarray(offset, end).toString('utf8').split(' ')
    const size = Number(sizeText)
    if (sha !== expected || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('Git object response was malformed')
    }
    const bodyEnd = end + 1 + size
    if (bodyEnd >= result.stdout.length) throw new Error('Git object response was truncated')
    if (type === 'blob' || type === 'commit') blobs.push({ type, content: result.stdout.subarray(end + 1, bodyEnd) })
    offset = bodyEnd + 1
  }
  return blobs
}

export function checkMachinePaths({ repo, home }) {
  const forms = homeForms(home)
  const failures = []
  const tracked = git(repo, ['ls-files', '--cached', '-z']).split('\0').filter(Boolean)
  const current = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0').filter(Boolean)

  for (const file of tracked) {
    try {
      if (containsHome(git(repo, ['show', `:${file}`], { encoding: null }), forms)) {
        failures.push('index file contains a machine-specific absolute home path')
      }
    } catch {
      // Intent-to-add entries have no index blob; the worktree scan owns them.
    }
  }
  for (const file of current) {
    const absolute = path.join(repo, file)
    if (!existsSync(absolute)) continue
    const content = lstatSync(absolute).isSymbolicLink()
      ? Buffer.from(readlinkSync(absolute))
      : readFileSync(absolute)
    if (containsHome(content, forms)) failures.push('worktree file contains a machine-specific absolute home path')
  }
  for (const object of historyBlobs(repo)) {
    if (containsHome(object.content, forms)) {
      failures.push(`Git ${object.type} contains a machine-specific absolute home path`)
    }
  }
  return { failures: [...new Set(failures)], files: current.length }
}

function main() {
  try {
    const result = checkMachinePaths({ repo: repositoryRoot, home: os.userInfo().homedir })
    if (result.failures.length > 0) {
      console.error('Machine-path check FAILED:')
      for (const failure of result.failures) console.error(`  - ${failure}`)
      process.exitCode = 1
      return
    }
    console.log('Machine-path check passed for current files and Git history.')
  } catch (error) {
    console.error(`Machine-path check FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
