import { chmodSync,existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,utimesSync,writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import {
checkCodexBinary,
CODEX_ATTACH_RETRY_MS,
codexAttachCheckDue,
privateServerSocket,
runCodexAttachCanary,
sweepStaleHomes
} from './codex-attach-canary.js'
import { codexAttachResultFor,codexBinaryIdentity } from './codex-attach-signal.js'
import { connectCodexControl } from './codex-native-control.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** Short: a Unix socket path must fit. */
function root(): string {
  const directory = realpathSync(mkdtempSync('/tmp/nfat-'))
  roots.push(directory)
  return directory
}

describe.skipIf(process.platform === 'win32')('the behaviour check stays inside its throwaway home', () => {
  it('accepts only a socket named inside the home and held by the server it started from there', () => {
    const home = root()
    const elsewhere = root()
    // Codex names the socket inside its home and links it to a per-user directory.
    const target = path.join(elsewhere, 'server.sock')
    writeFileSync(target, '')
    mkdirSync(path.join(home, 'c', 'app-server-control'), { recursive: true })
    const named = path.join(home, 'c', 'app-server-control', 'app-server-control.sock')
    symlinkSync(target, named)
    mkdirSync(path.join(home, 'c', 'packages'))
    const inside = path.join(home, 'c', 'packages', 'codex')
    const read = (executable: string | null, sockets: string[]) => ({ executable: () => executable, unixSockets: () => sockets })

    expect(privateServerSocket(home, named, 4242, read(inside, [target]))).toBe(target)
    // The User's own server: named outside the home.
    expect(privateServerSocket(home, target, 4242, read(inside, [target]))).toBeNull()
    // A server whose binary is not the copy inside the home.
    expect(privateServerSocket(home, named, 4242, read('/opt/homebrew/bin/codex', [target]))).toBeNull()
    expect(privateServerSocket(home, named, 4242, read(null, [target]))).toBeNull()
    // A socket that server does not hold.
    expect(privateServerSocket(home, named, 4242, read(inside, [path.join(elsewhere, 'other.sock')]))).toBeNull()
  })

  it('refuses a server by its socket before connecting to it', async () => {
    const home = root()
    const socketPath = path.join(home, 's.sock')
    let connections = 0
    const listener = createServer((socket) => { connections += 1; socket.destroy() })
    await new Promise<void>((resolve) => listener.listen(socketPath, resolve))
    try {
      const codex = path.join(home, 'codex')
      writeFileSync(codex, `#!/bin/sh\necho '${JSON.stringify({ status: 'running', socketPath })}'\n`)
      chmodSync(codex, 0o755)
      const stages: string[] = []
      const seen: string[] = []
      const control = await connectCodexControl('00000000-0000-0000-0000-000000000000', { CODEX_HOME: home, PATH: '/usr/bin:/bin' },
        performance.now() + 5_000, undefined, (stage) => stages.push(stage),
        { allowUnloaded: true, executable: codex, acceptSocket: (reported) => { seen.push(reported); return false } })
      expect(control).toBeNull()
      expect(seen).toEqual([socketPath])
      expect(stages).toEqual(['endpoint'])
      expect(connections).toBe(0)
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
  })
})

describe.skipIf(process.platform === 'win32')('a check its hub left mid-run', () => {
  it('is cleaned up by the next check once it is old, and a running one is left alone', async () => {
    const parent = root()
    const old = path.join(parent, 'nfac-old')
    const young = path.join(parent, 'nfac-young')
    const unrelated = path.join(parent, 'other-old')
    for (const directory of [old, young, unrelated]) mkdirSync(path.join(directory, 'c'), { recursive: true })
    const hourAgo = new Date(Date.now() - 60 * 60_000)
    for (const directory of [old, unrelated]) utimesSync(directory, hourAgo, hourAgo)
    await sweepStaleHomes(parent)
    expect([existsSync(old), existsSync(young), existsSync(unrelated)]).toEqual([false, true, true])
  })
})

describe('when the behaviour check runs', () => {
  const result = (outcome: 'passed' | 'failed', checkedAt: number) => ({
    binary: { path: '/x/codex', size: 1, mtimeMs: 1 }, codexVersion: '0.163.0', outcome, checkedAt,
  })

  it('runs for a binary never checked, and again only a day after a failure', () => {
    const now = 10 * CODEX_ATTACH_RETRY_MS
    expect(codexAttachCheckDue(null, now)).toBe(true)
    expect(codexAttachCheckDue(result('passed', 0), now)).toBe(false)
    expect(codexAttachCheckDue(result('failed', now - CODEX_ATTACH_RETRY_MS + 1), now)).toBe(false)
    expect(codexAttachCheckDue(result('failed', now - CODEX_ATTACH_RETRY_MS), now)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('retries an inability to start the check within seconds, without trusting the failed check', async () => {
    const home = root()
    const codex = path.join(home, 'codex')
    writeFileSync(codex, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 0.163.0"; exit 0; fi\necho "No space left on device" >&2\nexit 1\n', { mode: 0o755 })
    const env = { XDG_STATE_HOME: path.join(home, 'state') }
    const binary = codexBinaryIdentity(codex)!
    const failed = await checkCodexBinary(env, binary, 10_000, options => runCodexAttachCanary({ ...options, root: home }))
    expect(failed).toMatchObject({ outcome: 'failed', step: 0 })
    expect(failed.detail).toContain('No space left on device')
    expect(codexAttachCheckDue(failed, 10_001)).toBe(false)
    expect(codexAttachCheckDue(failed, 15_000)).toBe(true)
    expect(codexAttachResultFor(env, binary)?.outcome).toBe('failed')
  })
})
