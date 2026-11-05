/**
 * Notifai's hooks in a Codex server Notifai runs a background turn in
 * (`codex-app-hosted-turn.ts`): the launcher compiled from `launcher/main.c`
 * stands them down before anything else, and only for that server.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const supported = (process.platform === 'darwin' || process.platform === 'linux') && spawnSync('cc', ['--version']).status === 0
const BUILD = 'c'.repeat(64)
let root = ''
let launcher = ''
let runtimeLog = ''

beforeAll(() => {
  if (!supported) return
  root = mkdtempSync(path.join('/tmp', 'hosted-launcher-'))
  const compiled = path.join(root, 'compiled')
  execFileSync('cc', ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-D_XOPEN_SOURCE=700',
    ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE', '-mmacosx-version-min=13.0'] : []),
    '-Wall', '-Wextra', '-Werror', '-O2', fileURLToPath(new URL('../launcher/main.c', import.meta.url)), '-o', compiled], { stdio: 'inherit' })
  const install = path.join(root, 'home', '.notifai')
  const version = path.join(install, 'versions', BUILD)
  for (const directory of [path.join(root, 'home'), install, path.join(install, 'bin'), path.join(install, 'versions'), version]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  launcher = path.join(install, 'bin', 'notifai')
  copyFileSync(compiled, launcher)
  chmodSync(launcher, 0o700)
  writeFileSync(path.join(install, 'active.json'), `{"schema":1,"active":"${BUILD}","previous":null,"generation":1}\n`, { mode: 0o600 })
  runtimeLog = path.join(root, 'runtime')
  mkdirSync(runtimeLog)
  writeFileSync(path.join(version, 'notifai-runtime'), `#!/bin/sh\ncat > /dev/null\necho "$@" > "${runtimeLog}/args.$$"\n`, { mode: 0o700 })
}, 120_000)
afterAll(() => { if (root !== '') rmSync(root, { recursive: true, force: true }) })

function hook(marker: string | undefined): { status: number | null; runtimeRan: boolean } {
  const before = readdirSync(runtimeLog).length
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'), LANG: 'C',
    ...(marker === undefined ? {} : { NOTIFAI_HOSTED_TURN_PID: marker }) }
  // This test process is the hook's parent, as a Codex server is for its hooks.
  const run = spawnSync(launcher, ['hook', 'user-prompt-submit', '--owner', 'notifai', '--harness', 'codex'], { env, input: '{"session_id":"x"}', timeout: 20_000 })
  return { status: run.status, runtimeRan: readdirSync(runtimeLog).length > before }
}

describe.skipIf(!supported)('the launcher in a background turn\'s server', () => {
  it('stands Notifai\'s hooks down there, and nowhere else', () => {
    expect(hook(String(process.pid))).toEqual({ status: 0, runtimeRan: false })
    // A nested Codex (another parent), no marker, or a malformed one: hooks run as always.
    expect(hook('2147483000').runtimeRan).toBe(true)
    expect(hook(undefined).runtimeRan).toBe(true)
    expect(hook('not-a-pid').runtimeRan).toBe(true)
  })

  it('says it knows the marker', () => {
    expect(execFileSync(launcher, ['--internal-launcher-version'], { encoding: 'utf8' }).trim()).toBe('2')
  })
})
