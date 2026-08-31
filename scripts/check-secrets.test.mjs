import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'

const script = fileURLToPath(new URL('./check-secrets.mjs', import.meta.url))
const root = fileURLToPath(new URL('..', import.meta.url))

test('tree, range, and full modes are explicit and range validation fails closed', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'notifai-gitleaks-stub-'))
  const executable = path.join(fixture, process.platform === 'win32' ? 'gitleaks.cmd' : 'gitleaks')
  writeFileSync(
    executable,
    process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
  )
  if (process.platform !== 'win32') chmodSync(executable, 0o755)
  const env = {...process.env, PATH: `${fixture}${path.delimiter}${process.env.PATH ?? ''}`}

  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim()
    const base = execFileSync('git', ['rev-parse', 'HEAD^'], {cwd: root, encoding: 'utf8'}).trim()
    for (const args of [
      ['--mode', 'tree'],
      ['--mode', 'range', '--base', base, '--head', head],
      ['--mode', 'full'],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], {
        encoding: 'utf8',
        env,
      })
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    }

    const invalid = spawnSync(
      process.execPath,
      [script, '--mode', 'range', '--base', '0'.repeat(40), '--head', head],
      {encoding: 'utf8', env},
    )
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /range base must be a non-zero full lowercase commit SHA/u)
  } finally {
    rmSync(fixture, {recursive: true, force: true})
  }
})
