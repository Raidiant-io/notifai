import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkMachinePaths } from './check-machine-paths.mjs'

const exampleHome = '/Users/private-owner'

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function fixture(run) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'notifai-machine-paths-'))
  try {
    git(repo, 'init', '--quiet')
    git(repo, 'config', 'user.name', 'Scanner Control')
    git(repo, 'config', 'user.email', 'control@example.invalid')
    writeFileSync(path.join(repo, 'control.txt'), 'clean\n')
    git(repo, 'add', 'control.txt')
    git(repo, 'commit', '--quiet', '-m', 'base')
    run(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

test('accepts a clean tree and history', () => {
  fixture(repo => assert.deepEqual(checkMachinePaths({ repo, home: exampleHome }).failures, []))
})

test('rejects an owner path in current files without echoing the path', () => {
  fixture(repo => {
    writeFileSync(path.join(repo, 'control.txt'), `source = ${exampleHome}/project\n`)
    const result = checkMachinePaths({ repo, home: exampleHome })
    assert.ok(result.failures.some(failure => failure.includes('worktree file')))
    assert.ok(result.failures.every(failure => !failure.includes(exampleHome)))
  })
})

test('rejects a bare owner path without confusing a longer username', () => {
  fixture(repo => {
    writeFileSync(path.join(repo, 'control.txt'), `source = ${exampleHome}-other/project\n`)
    assert.deepEqual(checkMachinePaths({ repo, home: exampleHome }).failures, [])
    writeFileSync(path.join(repo, 'control.txt'), `source = "${exampleHome}"\n`)
    assert.ok(checkMachinePaths({ repo, home: exampleHome }).failures.length > 0)
  })
})

test('rejects an owner path retained only in a prior commit', () => {
  fixture(repo => {
    writeFileSync(path.join(repo, 'control.txt'), `source = ${exampleHome}/project\n`)
    git(repo, 'add', 'control.txt')
    git(repo, 'commit', '--quiet', '-m', 'temporary path')
    writeFileSync(path.join(repo, 'control.txt'), 'clean again\n')
    git(repo, 'add', 'control.txt')
    git(repo, 'commit', '--quiet', '-m', 'remove path')
    const result = checkMachinePaths({ repo, home: exampleHome })
    assert.ok(result.failures.some(failure => failure.includes('Git blob')))
  })
})

test('rejects an owner path in a commit message', () => {
  fixture(repo => {
    git(repo, 'commit', '--quiet', '--allow-empty', '-m', `debug ${exampleHome}/project`)
    const result = checkMachinePaths({ repo, home: exampleHome })
    assert.ok(result.failures.some(failure => failure.includes('Git commit')))
  })
})
