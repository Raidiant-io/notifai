import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { commandInvocation } from './cross-platform.mjs'

test('invokes pnpm through its installed JavaScript entry on Windows', () => {
  const home = 'C:\\Users\\runner\\setup-pnpm\\node_modules\\.bin'
  const invocation = commandInvocation(
    'pnpm',
    ['--filter', '@raidiant/notifai', 'pack', '--dry-run', '--json'],
    'win32',
    { PNPM_HOME: home },
  )

  assert.equal(invocation.file, process.execPath)
  assert.deepEqual(invocation.args, [
    path.join(path.dirname(home), 'pnpm', 'bin', 'pnpm.cjs'),
    '--filter',
    '@raidiant/notifai',
    'pack',
    '--dry-run',
    '--json',
  ])
  assert.deepEqual(invocation.options, { windowsHide: true })
})

test('keeps POSIX package-manager execution direct', () => {
  assert.deepEqual(commandInvocation('pnpm', ['pack'], 'linux', {}), {
    file: 'pnpm',
    args: ['pack'],
    options: {},
  })
})
