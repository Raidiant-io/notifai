import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
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

test('positive controls cannot change the repository exported by a Git hook', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'notifai-hook-git-control-'))
  const unrelated = path.join(fixture, 'unrelated')
  const executable = path.join(fixture, process.platform === 'win32' ? 'gitleaks.cmd' : 'gitleaks')
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  )
  const git = (args) => execFileSync('git', args, {cwd: unrelated, env: cleanEnv, encoding: 'utf8'}).trim()

  try {
    mkdirSync(unrelated)
    git(['init', '--quiet'])
    git(['config', 'user.name', 'Unrelated Repository'])
    git(['config', 'user.email', 'unrelated@example.invalid'])
    git(['commit', '--quiet', '--allow-empty', '-m', 'unchanged'])
    const originalHead = git(['rev-parse', 'HEAD'])

    writeFileSync(executable, process.platform === 'win32'
      ? '@echo off\r\nif "%1"=="git" exit /b 23\r\nfindstr /b "TOKEN=ghp_" control.txt >nul\r\nif not errorlevel 1 exit /b 23\r\nexit /b 0\r\n'
      : '#!/bin/sh\nif [ "$1" = "git" ]; then exit 23; fi\nif grep -q "^TOKEN=ghp_" control.txt; then exit 23; fi\nexit 0\n')
    if (process.platform !== 'win32') chmodSync(executable, 0o755)

    const result = spawnSync(process.execPath, [script, '--mode', 'controls'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...cleanEnv,
        PATH: `${fixture}${path.delimiter}${cleanEnv.PATH ?? ''}`,
        GIT_DIR: path.join(unrelated, '.git'),
        GIT_WORK_TREE: unrelated,
        GIT_INDEX_FILE: path.join(fixture, 'hostile.index'),
        GIT_PREFIX: 'outside/',
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /positive controls passed/u)
    assert.equal(git(['rev-parse', 'HEAD']), originalHead)
    assert.equal(git(['config', '--get', 'core.bare']), 'false')
    assert.equal(git(['config', '--get', 'user.name']), 'Unrelated Repository')
    assert.equal(git(['status', '--porcelain']), '')
  } finally {
    rmSync(fixture, {recursive: true, force: true})
  }
})
