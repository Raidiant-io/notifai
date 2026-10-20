import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitQuery, inHookScope, shareGitIdentityAnswers } from './git-query.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A `git` on PATH that records each call and answers `/answer`. */
function fakeGit(): { env: NodeJS.ProcessEnv; calls: () => string[]; cwd: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-query-'))
  roots.push(root)
  const bin = path.join(root, 'bin')
  const cwd = path.join(root, 'work')
  mkdirSync(bin)
  mkdirSync(cwd)
  const log = path.join(root, 'calls')
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$GIT_MARK $*" >> '${log}'\necho /answer\n`, { mode: 0o755 })
  return { env: { PATH: `${bin}:/usr/bin:/bin`, GIT_MARK: 'hook' }, cwd,
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] }
}

describe.skipIf(process.platform === 'win32')('git queries in a hook scope', () => {
  it('asks Git each question once per hook, under the hook\'s own environment', async () => {
    const git = fakeGit()
    const answers = await inHookScope(git.env, async () => [
      gitQuery(git.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      gitQuery(git.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ])
    expect(answers).toEqual(['/answer', '/answer'])
    expect(git.calls()).toEqual([`hook -C ${git.cwd} rev-parse --abbrev-ref HEAD`])
    // A branch is asked again by the next hook.
    await inHookScope(git.env, async () => gitQuery(git.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))
    expect(git.calls()).toHaveLength(2)
  })

  it('shares a repository-identity answer across hooks only while Git\'s discovery would see the same `.git`', async () => {
    shareGitIdentityAnswers()
    const git = fakeGit()
    const ask = (): Promise<string | null> => inHookScope(git.env, async () => gitQuery(git.cwd, ['rev-parse', '--git-common-dir']))
    await ask()
    await ask()
    expect(git.calls()).toHaveLength(1)
    // A repository appears where discovery looks: the next hook asks Git again.
    mkdirSync(path.join(git.cwd, '.git'))
    await ask()
    expect(git.calls()).toHaveLength(2)
    await ask()
    expect(git.calls()).toHaveLength(2)
    // Another Git environment is another question.
    await inHookScope({ ...git.env, GIT_DIR: '/elsewhere' }, async () => gitQuery(git.cwd, ['rev-parse', '--git-common-dir']))
    expect(git.calls()).toHaveLength(3)
  })
})
