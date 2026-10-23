import { spawn,type ChildProcess } from 'node:child_process'
import {
existsSync,
lstatSync,
mkdirSync,
mkdtempSync,
readFileSync,
readdirSync,
renameSync,
rmSync,
statSync,
symlinkSync,
writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe,expect,it } from 'vitest'
import { withFileLock,withTargetFileLock } from './file-lock.js'

interface LockWorker {
  child: ChildProcess
  done: Promise<void>
  pausedPath: string
  continuePath: string
  enteredPath: string
  releasePath: string
  waitsPath: string
}

interface LockWorkerOptions {
  pauseAt?: string
  action?: 'hold' | 'crash'
}

function waitCount(file: string): number {
  try {
    return Number(readFileSync(file, 'utf8'))
  } catch {
    return 0
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for file-lock worker')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function lockWorker(
  root: string,
  lockPath: string,
  id: string,
  options: LockWorkerOptions = {},
): LockWorker {
  const marker = (name: string): string => path.join(root, `${id}-${name}`)
  const pausedPath = marker('paused')
  const continuePath = marker('continue')
  const enteredPath = marker('entered')
  const releasePath = marker('release')
  const waitsPath = marker('waits')
  const vitest = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
  const child = spawn(
    process.execPath,
    [vitest, 'run', 'src/file-lock-process-worker.test.ts', '--reporter=dot', '--maxWorkers=1'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NOTIFAI_FILE_LOCK_WORKER: id,
        NOTIFAI_FILE_LOCK_PATH: lockPath,
        NOTIFAI_FILE_LOCK_PAUSED: pausedPath,
        NOTIFAI_FILE_LOCK_CONTINUE: continuePath,
        NOTIFAI_FILE_LOCK_ENTERED: enteredPath,
        NOTIFAI_FILE_LOCK_RELEASE: releasePath,
        NOTIFAI_FILE_LOCK_WAITS: waitsPath,
        NOTIFAI_FILE_LOCK_ACTION: options.action ?? 'hold',
        ...(options.pauseAt === undefined
          ? {}
          : { NOTIFAI_FILE_LOCK_PAUSE_AT: options.pauseAt }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk))
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      const expectedExit =
        options.action === 'crash' ? code !== 0 || signal !== null : code === 0
      if (expectedExit) resolve()
      else {
        reject(
          new Error(
            `file-lock worker ${id} exited ${String(code)}\n${Buffer.concat(stdout).toString()}\n${Buffer.concat(stderr).toString()}`,
          ),
        )
      }
    })
  })
  void done.catch(() => undefined)
  return { child, done, pausedPath, continuePath, enteredPath, releasePath, waitsPath }
}

function stop(workers: LockWorker[]): void {
  for (const worker of workers) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL')
  }
}

describe('cross-process file lock', () => {
  it('does not expose an ownerless publication window before acquisition is complete', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-file-lock-'))
    const lockPath = path.join(root, 'shared.lock')
    const workers: LockWorker[] = []
    try {
      const first = lockWorker(root, lockPath, 'first', { pauseAt: 'choosing-published' })
      workers.push(first)
      await waitUntil(() => existsSync(first.pausedPath))

      const published = readdirSync(lockPath)
      expect(published).toHaveLength(1)
      expect(published[0]).toMatch(/^choosing-\d+-[0-9a-f]+$/)
      expect(statSync(path.join(lockPath, published[0]!)).size).toBe(0)

      const second = lockWorker(root, lockPath, 'second')
      workers.push(second)
      await waitUntil(() => existsSync(second.pausedPath) && waitCount(second.waitsPath) > 0)
      expect(existsSync(first.enteredPath)).toBe(false)
      expect(existsSync(second.enteredPath)).toBe(false)

      writeFileSync(first.continuePath, 'continue')
      await waitUntil(() => existsSync(first.enteredPath) !== existsSync(second.enteredPath))

      const winner = existsSync(first.enteredPath) ? first : second
      const loser = winner === first ? second : first
      const waitsBefore = waitCount(loser.waitsPath)
      await waitUntil(() => {
        if (existsSync(loser.enteredPath)) throw new Error('both lock actions overlapped')
        return waitCount(loser.waitsPath) > waitsBefore
      })

      writeFileSync(winner.releasePath, 'release')
      await waitUntil(() => existsSync(loser.enteredPath))
      writeFileSync(loser.releasePath, 'release')
      await Promise.all(workers.map(({ done }) => done))
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      stop(workers)
      await Promise.allSettled(workers.map(({ done }) => done))
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('rendezvous contention', () => {
  // The last contender out removes the rendezvous directory, so a contender
  // registering at that instant races the removal. Both tests drive that race
  // from the registering observation, which is the window the racing releaser
  // would otherwise have to hit by luck — on a loaded machine it does.
  function raceAtRegistration(interfere: (lock: string) => void): void {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-rendezvous-'))
    const lock = path.join(root, 'shared.lock')
    let raced = false
    let entered = 0

    withFileLock(lock, () => { entered += 1 }, {
      observe(observation) {
        if (observation.phase !== 'registering' || raced) return
        raced = true
        interfere(lock)
      },
    })

    expect(raced).toBe(true)
    expect(entered).toBe(1)
    // Release still cleans up after itself, whichever rendezvous it ended in.
    expect(existsSync(lock)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  }

  it('registers again when a releasing contender removed the rendezvous', () => {
    raceAtRegistration((lock) => rmSync(lock, { recursive: true }))
  })
})

describe('directory-entry races', () => {
  it.each([
    { phase: 'ticket selection', code: 'ENOENT', token: 'f'.repeat(25) },
    { phase: 'admission', code: 'ENOENT', token: '0' },
    { phase: 'admission', code: 'EPERM', token: '0' },
  ])('waits for a chooser renamed during $phase ($code)', ({ phase, code, token }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-entry-race-'))
    const target = path.join(root, 'settings.json')
    const lock = path.join(root, '.settings.json.notifai.lock')
    const choosing = path.join(lock, `choosing-${process.pid}-${token}`)
    // The peer selected ticket 1 while we were choosing. During ticket
    // selection its token sorts last, so missing it lets us jump ahead with
    // ticket 1. During admission it sorts first and must block our ticket 1.
    const peerTicket = path.join(lock, `ticket-1-${process.pid}-${token}`)
    let renamed = false
    let waited = false
    let entered = false

    try {
      withTargetFileLock(target, () => {
        expect(existsSync(peerTicket), 'transactions must not overlap').toBe(false)
        entered = true
      }, {
        observe(observation) {
          if (observation.phase === 'choosing-published') writeFileSync(choosing, '')
          if (observation.phase === 'waiting' && observation.blockers.includes(path.basename(peerTicket))) {
            waited = true
            rmSync(peerTicket)
          }
        },
        lstatEntry(file) {
          const selected = readdirSync(lock).some((name) => name.startsWith('ticket-'))
          if (file === choosing && !renamed && selected === (phase === 'admission')) {
            renamed = true
            renameSync(choosing, peerTicket)
            if (code === 'EPERM') {
              throw Object.assign(new Error('entry is being renamed'), { code })
            }
          }
          return lstatSync(file)
        },
      })

      expect(renamed).toBe(true)
      expect(waited).toBe(true)
      expect(entered).toBe(true)
      expect(existsSync(lock)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('target file transaction lock', () => {
  it('refuses a symlinked target parent before publishing a contender', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-target-lock-'))
    const foreign = path.join(root, 'foreign')
    const linked = path.join(root, 'linked')
    mkdirSync(foreign)
    symlinkSync(foreign, linked)

    expect(() => withTargetFileLock(path.join(linked, 'settings.json'), () => {})).toThrow(
      /not a regular directory/,
    )
    expect(existsSync(path.join(foreign, '.settings.json.notifai.lock'))).toBe(false)
  })

  it('preserves the action error when release also finds a replacement', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-target-lock-'))
    const target = path.join(root, 'settings.json')
    const lock = path.join(root, '.settings.json.notifai.lock')
    const actionError = new Error('merge failed')

    expect(() =>
      withTargetFileLock(target, () => {
        const entry = path.join(lock, readdirSync(lock)[0]!)
        rmSync(entry)
        writeFileSync(entry, 'replacement')
        throw actionError
      }),
    ).toThrow(actionError)
  })
})
