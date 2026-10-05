#!/usr/bin/env node
// Runs the delivered executable outside a checkout, with no package/runtime PATH.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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
  assert.equal(receipt.processVerified, true, 'native process identity must prove the running process')
  assert.ok(receipt.build.version)
  assert.ok(receipt.skill.files > 0)
  return receipt
}
try {
  const receipt = check()
  assert.deepEqual(readdirSync(home), [], 'self-check must not create account or logging state')
  const refused = spawnSync(executable, ['config', 'set', 'log_level', 'off', '--yes'], {
    cwd, env, encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(refused.error, undefined)
  assert.equal(refused.status, 1, 'A portable executable must refuse shared-state mutations before installation')
  assert.match(refused.stderr, /Install Notifai/)
  assert.deepEqual(readdirSync(home), [], 'Refused portable commands must not write configuration or logs')
  for (const args of [['--help'], ['--version'], ['install', '--help'], ['doctor', '--json']]) {
    const diagnostic = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 20_000 })
    assert.equal(diagnostic.error, undefined)
    assert.equal(diagnostic.status, args[0] === 'doctor' ? 1 : 0, diagnostic.stderr)
    if (args[0] === 'doctor') assert.equal(JSON.parse(diagnostic.stdout).read_only, true)
    assert.deepEqual(readdirSync(home), [], 'Portable diagnostics must not write local state')
  }
  writeFileSync(path.join(cwd, 'preload.js'), 'throw new Error("UNTRUSTED_PRELOAD_EXECUTED")\n')
  writeFileSync(path.join(cwd, '.env'), 'BUN_OPTIONS=--preload ./preload.js\n')
  writeFileSync(path.join(cwd, 'bunfig.toml'), 'preload = ["./preload.js"]\n')
  assert.deepEqual(check(), receipt, 'cwd configuration must not alter the executable')
  assert.deepEqual(check({ BUN_OPTIONS: '--preload ./preload.js' }), receipt)
  assert.deepEqual(check({ BUN_BE_BUN: '1' }), receipt)
  const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
  process.stdout.write(`${JSON.stringify({ ok: true, build: receipt.build, launcher_sha256: sha256(executable),
    runtime_sha256: sha256(path.join(path.dirname(executable), process.platform === 'win32' ? 'notifai-runtime.exe' : 'notifai-runtime')), checks: [
    'isolated-no-runtime-path', 'embedded-skill-integrity', 'process-identity', 'portable-command-admission',
    'portable-read-only-diagnostics', 'cwd-config', 'BUN_OPTIONS', 'BUN_BE_BUN',
  ] })}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
