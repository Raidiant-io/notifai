import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chmodCliBin, CLI_BIN, POSIX_MODE } from './chmod-cli-bin.mjs'

test('POSIX builds leave dist/main.js executable', () => {
  if (process.platform === 'win32') return
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-chmod-cli-'))
  mkdirSync(path.join(cwd, 'dist'))
  const file = path.join(cwd, CLI_BIN)
  writeFileSync(file, '#!/usr/bin/env node\n')
  chmodSync(file, 0o644)
  assert.equal(statSync(file).mode & 0o111, 0)
  const result = chmodCliBin(cwd, 'darwin')
  assert.equal(result.skipped, false)
  assert.equal(result.mode, POSIX_MODE)
  assert.equal(statSync(file).mode & 0o111, 0o111)
})

test('Windows builds skip the execute-bit repair', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-chmod-win-'))
  const result = chmodCliBin(cwd, 'win32')
  assert.deepEqual(result, { skipped: true, path: null, mode: null })
})
