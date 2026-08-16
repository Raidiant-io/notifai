#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { repositoryRoot } from './cross-platform.mjs'

const root = repositoryRoot
const gitleaks = process.env.GITLEAKS_BIN || 'gitleaks'

function run(args, cwd, expected) {
  const result = spawnSync(gitleaks, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== expected) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim()
    throw new Error(`${gitleaks} ${args.join(' ')} exited ${result.status}, expected ${expected}${detail ? `\n${detail}` : ''}`)
  }
}

function positiveControls() {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'notifai-secret-control-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: fixture })
    execFileSync('git', ['config', 'user.name', 'Secret Scanner Control'], { cwd: fixture })
    execFileSync('git', ['config', 'user.email', 'control@example.invalid'], { cwd: fixture })

    // Construct the canary at runtime so the scanner source itself stays clean.
    //
    // Drawn from the alphabet the rule it proves actually matches. It used to
    // come from base64url, which includes `-` and `_`, so two thirds of runs
    // produced a canary the personal-access-token rule could not match and the
    // control passed only when some generic entropy rule happened to fire
    // instead. A gate that fails at random is one people learn to re-run rather
    // than read.
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const canary =
      ['gh', 'p'].join('') +
      '_' +
      Array.from(randomBytes(36), (byte) => alphabet[byte % alphabet.length]).join('')
    const canaryFile = path.join(fixture, 'control.txt')
    writeFileSync(canaryFile, `TOKEN=${canary}\n`)
    run(['dir', '--no-banner', '--redact', '--exit-code', '23', '.'], fixture, 23)

    execFileSync('git', ['add', 'control.txt'], { cwd: fixture })
    execFileSync('git', ['commit', '--quiet', '-m', 'add scanner control'], { cwd: fixture })
    writeFileSync(canaryFile, 'control removed\n')
    execFileSync('git', ['add', 'control.txt'], { cwd: fixture })
    execFileSync('git', ['commit', '--quiet', '-m', 'remove scanner control'], { cwd: fixture })

    // The live tree is clean, but the history scan must still find the old value.
    run(['dir', '--no-banner', '--redact', '--exit-code', '23', '.'], fixture, 0)
    run(['git', '--no-banner', '--redact', '--exit-code', '23', '--log-opts=--all', '.'], fixture, 23)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

try {
  positiveControls()
  run(['dir', '--no-banner', '--redact', '--exit-code', '1', '.'], root, 0)
  run(['git', '--no-banner', '--redact', '--exit-code', '1', '--log-opts=--all', '.'], root, 0)
} catch (error) {
  console.error(`Secret/history check FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

console.log('Secret and full-history scans passed; both positive controls detected their canaries.')
