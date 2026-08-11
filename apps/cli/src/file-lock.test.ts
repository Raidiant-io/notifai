import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

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

  it('cannot reap a successor after observing a dead owner', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-file-lock-'))
    const lockPath = path.join(root, 'shared.lock')
    const workers: LockWorker[] = []
    try {
      const crashed = lockWorker(root, lockPath, 'crashed', { action: 'crash' })
      workers.push(crashed)
      await waitUntil(() => existsSync(crashed.enteredPath))
      await crashed.done

      const staleEntries = readdirSync(lockPath)
      expect(staleEntries).toHaveLength(1)
      expect(staleEntries[0]).toMatch(/^ticket-\d+-\d+-[0-9a-f]+$/)
      const staleEntry = staleEntries[0]!

      const delayedReaper = lockWorker(root, lockPath, 'delayed-reaper', {
        pauseAt: 'stale-entry',
      })
      workers.push(delayedReaper)
      await waitUntil(
        () =>
          existsSync(delayedReaper.pausedPath) &&
          readFileSync(delayedReaper.pausedPath, 'utf8') === staleEntry,
      )

      const successor = lockWorker(root, lockPath, 'successor')
      workers.push(successor)
      await waitUntil(() => existsSync(successor.enteredPath))
      const successorEntry = readdirSync(lockPath).find((entry) => entry.startsWith('ticket-'))
      expect(successorEntry).toBeDefined()
      expect(successorEntry).not.toBe(staleEntry)

      writeFileSync(delayedReaper.continuePath, 'continue')
      await waitUntil(() => {
        if (existsSync(delayedReaper.enteredPath)) {
          throw new Error('the delayed stale cleanup displaced the successor')
        }
        return waitCount(delayedReaper.waitsPath) > 0
      })

      writeFileSync(successor.releasePath, 'release')
      await waitUntil(() => existsSync(delayedReaper.enteredPath))
      writeFileSync(delayedReaper.releasePath, 'release')
      await Promise.all([successor.done, delayedReaper.done])
    } finally {
      stop(workers)
      await Promise.allSettled(workers.map(({ done }) => done))
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
