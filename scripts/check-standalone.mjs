#!/usr/bin/env node
// Runs the delivered executable outside a checkout, with no package/runtime PATH.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const executable = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: node scripts/check-standalone.mjs <executable>')
const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-standalone-check-'))
const home = path.join(root, 'home')
const cwd = path.join(root, 'project with spaces')
mkdirSync(home)
mkdirSync(cwd)
// Keep only OS necessities. In particular, no external Node/Bun/Git and no real
// account, harness state, or inherited Notifai overrides enter the application.
const env = { HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
  PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin',
  ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local') } : {}),
}
function check(overrides = {}) {
  const result = spawnSync(executable, ['self-check', '--json'], {
    cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(result.stdout)
  assert.equal(receipt.ok, true)
  assert.ok(receipt.build.version)
  assert.ok(receipt.skill.files > 0)
  return receipt
}
try {
  const receipt = check()
  assert.deepEqual(readdirSync(home), [], 'self-check must not create account or logging state')
  writeFileSync(path.join(cwd, 'preload.js'), 'throw new Error("UNTRUSTED_PRELOAD_EXECUTED")\n')
  writeFileSync(path.join(cwd, '.env'), 'BUN_OPTIONS=--preload ./preload.js\n')
  writeFileSync(path.join(cwd, 'bunfig.toml'), 'preload = ["./preload.js"]\n')
  assert.deepEqual(check(), receipt, 'cwd configuration must not alter the executable')
  assert.deepEqual(check({ BUN_OPTIONS: '--preload ./preload.js' }), receipt)
  assert.deepEqual(check({ BUN_BE_BUN: '1' }), receipt)
  process.stdout.write(`${JSON.stringify({ ok: true, build: receipt.build, checks: [
    'isolated-no-runtime-path', 'embedded-skill-integrity', 'cwd-config', 'BUN_OPTIONS', 'BUN_BE_BUN',
  ] })}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
