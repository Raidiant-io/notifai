import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { commandInvocation } from './cross-platform.mjs'

const packArgs = ['--filter', '@raidiant/notifai', 'pack', '--dry-run', '--json']

test('reuses the active pnpm entry on Windows when the parent script names it', () => {
  const executable = 'C:\\pnpm\\10.34.5\\bin\\pnpm.cjs'
  const invocation = commandInvocation('pnpm', packArgs, 'win32', {
    npm_execpath: executable,
  })

  assert.equal(invocation.file, process.execPath)
  assert.deepEqual(invocation.args, [executable, ...packArgs])
  assert.deepEqual(invocation.options, { windowsHide: true })
})

test('reads the active pnpm entry from its Windows shim', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-pnpm-home-'))
  const store = path.join(path.dirname(home), 'store', 'pnpm.cjs')
  mkdirSync(path.dirname(store), { recursive: true })
  writeFileSync(path.join(home, 'pnpm.cmd'), `@ECHO OFF\r\nnode  "%~dp0\\..\\store\\pnpm.cjs" %*\r\n`)
  const invocation = commandInvocation('pnpm', packArgs, 'win32', { PNPM_HOME: home })

  assert.equal(invocation.file, process.execPath)
  assert.deepEqual(invocation.args, [store, ...packArgs])
  assert.deepEqual(invocation.options, { windowsHide: true })
})

test('keeps POSIX package-manager execution direct', () => {
  assert.deepEqual(commandInvocation('pnpm', ['pack'], 'linux', {}), {
    file: 'pnpm',
    args: ['pack'],
    options: {},
  })
})
