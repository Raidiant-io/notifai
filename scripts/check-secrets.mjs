#!/usr/bin/env node
import {execFileSync, spawnSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {repositoryRoot} from './cross-platform.mjs'

const gitleaks = 'gitleaks'
const SHA = /^[0-9a-f]{40}$/u
const ZERO_SHA = '0'.repeat(40)

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function run(args, cwd, expected, forbidden = []) {
  const result = spawnSync(gitleaks, args, {cwd, encoding: 'utf8'})
  if (result.error) throw result.error
  const output = `${result.stdout || ''}${result.stderr || ''}`
  for (const value of forbidden) {
    if (value && output.includes(value)) throw new Error('secret scanner printed a canary value')
  }
  if (result.status !== expected) {
    const detail = output.trim()
    throw new Error(
      `${gitleaks} ${args.join(' ')} exited ${result.status}, expected ${expected}${detail ? `\n${detail}` : ''}`,
    )
  }
}

const scanArgs = (subcommand, ...rest) => [subcommand, '--no-banner', '--redact', ...rest]

function positiveControls() {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'notifai-secret-control-'))
  try {
    execFileSync('git', ['init', '--quiet'], {cwd: fixture})
    execFileSync('git', ['config', 'user.name', 'Secret Scanner Control'], {cwd: fixture})
    execFileSync('git', ['config', 'user.email', 'control@example.invalid'], {cwd: fixture})
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'base'], {cwd: fixture})
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: fixture, encoding: 'utf8'}).trim()

    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const canary = ['gh', 'p'].join('') + '_' +
      Array.from(randomBytes(36), byte => alphabet[byte % alphabet.length]).join('')
    const canaryFile = path.join(fixture, 'control.txt')
    writeFileSync(canaryFile, `TOKEN=${canary}\n`)
    run(scanArgs('dir', '--exit-code', '23', '.'), fixture, 23, [canary])

    execFileSync('git', ['add', 'control.txt'], {cwd: fixture})
    execFileSync('git', ['commit', '--quiet', '-m', 'add scanner control'], {cwd: fixture})
    writeFileSync(canaryFile, 'control removed\n')
    execFileSync('git', ['add', 'control.txt'], {cwd: fixture})
    execFileSync('git', ['commit', '--quiet', '-m', 'remove scanner control'], {cwd: fixture})
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: fixture, encoding: 'utf8'}).trim()

    run(scanArgs('dir', '--exit-code', '23', '.'), fixture, 0, [canary])
    run(scanArgs('git', '--exit-code', '23', `--log-opts=${base}..${head}`, '.'), fixture, 23, [canary])
    run(scanArgs('git', '--exit-code', '23', '--log-opts=--all', '.'), fixture, 23, [canary])
  } finally {
    rmSync(fixture, {recursive: true, force: true})
  }
}

function requireCommit(repo, value, label) {
  if (!SHA.test(value ?? '') || value === ZERO_SHA) {
    throw new Error(`${label} must be a non-zero full lowercase commit SHA`)
  }
  const result = spawnSync('git', ['cat-file', '-e', `${value}^{commit}`], {cwd: repo, encoding: 'utf8'})
  if (result.status !== 0) throw new Error(`${label} is not a commit in the checked-out history`)
}

function scan(mode, repo, base, head) {
  if (mode === 'controls') {
    positiveControls()
    return 'Secret-scanner positive controls passed without printing canaries.'
  }
  if (mode === 'tree') {
    run(scanArgs('dir', '--exit-code', '1', '.'), repo, 0)
    return 'Current-tree secret scan passed.'
  }
  if (mode === 'range') {
    requireCommit(repo, base, 'range base')
    requireCommit(repo, head, 'range head')
    run(scanArgs('git', '--exit-code', '1', `--log-opts=${base}..${head}`, '.'), repo, 0)
    return 'Changed-range secret scan passed.'
  }
  if (mode === 'full') {
    run(scanArgs('git', '--exit-code', '1', '--log-opts=--all', '.'), repo, 0)
    return 'Full-history secret scan passed.'
  }
  throw new Error('mode must be one of: controls, tree, range, full')
}

try {
  console.log(scan(argument('--mode'), argument('--repo') ?? repositoryRoot, argument('--base'), argument('--head')))
} catch (error) {
  console.error(`Secret check FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
