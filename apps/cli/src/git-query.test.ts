import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { gitQuery } from './git-query.js'

let root: string
let calls: string
const savedPath = process.env['PATH']

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'notifai-git-query-')))
  calls = path.join(root, 'calls')
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  // Stands in for macOS's /usr/bin/git, which offers to install the developer tools when they are missing.
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${calls}'\necho '.git'\n`)
  chmodSync(path.join(bin, 'git'), 0o755)
  process.env['PATH'] = `${bin}:/usr/bin:/bin`
})

afterEach(() => {
  process.env['PATH'] = savedPath
  rmSync(root, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32')('never runs git where no repository can be found', () => {
  const plain = path.join(root, 'plain', 'folder')
  mkdirSync(plain, { recursive: true })

  expect(gitQuery(plain, ['rev-parse', '--git-common-dir'])).toBeNull()
  expect(existsSync(calls)).toBe(false)

  mkdirSync(path.join(root, 'plain', '.git'))
  expect(gitQuery(plain, ['rev-parse', '--git-common-dir'])).toBe('.git')
  expect(readFileSync(calls, 'utf8')).toContain('rev-parse --git-common-dir')
})
