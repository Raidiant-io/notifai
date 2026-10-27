import { spawn } from 'node:child_process'
import {
existsSync,
mkdtempSync,
readFileSync,
renameSync,
rmSync,
statSync,
writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe,expect,it } from 'vitest'
import { withFileLock } from './file-lock.js'
import {
LOG_SCHEMA_VERSION,
activeLogPath,
archiveLogPaths,
createLogger,
logsDiskUsage,
readLogRecords,
renderRecord,
serialize,
type LogRecord
} from './logging.js'

function sandbox(): NodeJS.ProcessEnv {
  return { XDG_STATE_HOME: mkdtempSync(path.join(os.tmpdir(), 'notifai-logs-')) }
}

function lines(env: NodeJS.ProcessEnv): LogRecord[] {
  return readFileSync(activeLogPath(env), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogRecord)
}

async function waitUntil(predicate: () => boolean, deadline: number): Promise<void> {
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for rotation workers')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface RotationRun {
  env: NodeJS.ProcessEnv
  worker: number
  records: number
  maxBytes: number
  maxFiles: number
  startPath: string
  /**
   * When the rendezvous has failed, as an absolute instant every participant
   * reads the same way. A per-side countdown would let the first worker to
   * report ready abandon a parent that is still waiting for the last one.
   */
  deadline: number
}

function rotationWorker(run: RotationRun): { readyPath: string; done: Promise<void> } {
  const { env, worker } = run
  const readyPath = path.join(env['XDG_STATE_HOME']!, `rotation-ready-${worker}`)
  const vitest = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
  const child = spawn(
    process.execPath,
    [vitest, 'run', 'src/logging-process-worker.test.ts', '--reporter=dot', '--maxWorkers=1'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        NOTIFAI_ROTATION_WORKER: String(worker),
        NOTIFAI_ROTATION_RECORDS: String(run.records),
        NOTIFAI_ROTATION_MAX_BYTES: String(run.maxBytes),
        NOTIFAI_ROTATION_MAX_FILES: String(run.maxFiles),
        NOTIFAI_ROTATION_READY: readyPath,
        NOTIFAI_ROTATION_START: run.startPath,
        NOTIFAI_ROTATION_DEADLINE: String(run.deadline),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else {
        reject(
          new Error(
            `rotation worker ${worker} exited ${String(code)}\n${Buffer.concat(stdout).toString()}\n${Buffer.concat(stderr).toString()}`,
          ),
        )
      }
    })
  })
  return { readyPath, done }
}

describe('the record', () => {
  it('is one self-describing JSON object per line', () => {
    const env = sandbox()
    const logger = createLogger({ env, cmd: 'send', runId: 'r_test' })
    logger.info('send.submitted', { request_id: 'req_1' })
    logger.info('send.outcome', { request_id: 'req_1' })

    const written = lines(env)
    expect(written).toHaveLength(2)
    // Every line stands alone: a line pulled out by grep, with no header and no
    // neighbours, still says what it is and which run it belongs to.
    for (const record of written) {
      expect(record.v).toBe(LOG_SCHEMA_VERSION)
      expect(record.run).toBe('r_test')
      expect(record.cmd).toBe('send')
      expect(record.pid).toBe(process.pid)
      expect(() => new Date(record.ts).toISOString()).not.toThrow()
    }
  })
})

describe('level', () => {
  it('records nothing at off', () => {
    const env = sandbox()
    const logger = createLogger({ env, settings: { level: 'off' } })
    logger.error('cli.error', {})
    expect(logsDiskUsage(env).files).toBe(0)
    expect(logger.enabled).toBe(false)
  })
})

describe('redaction', () => {
  it('never writes a machine token, wherever it appears', () => {
    const env = sandbox()
    const logger = createLogger({ env })
    logger.info('http.call', {
      authorization: 'Bearer nfm_abc123.supersecretvalue',
      message: 'rejected credential nfm_abc123.supersecretvalue for this machine',
      nested: { poll_verifier: 'v_secret', fine: 'kept' },
    })

    const raw = readFileSync(activeLogPath(env), 'utf8')
    expect(raw).not.toContain('supersecretvalue')
    expect(raw).not.toContain('v_secret')
    expect(raw).toContain('kept')
  })
})

describe('record size', () => {
  it('drops an oversized payload rather than the event', () => {
    const record: LogRecord = {
      v: LOG_SCHEMA_VERSION,
      ts: new Date(0).toISOString(),
      level: 'info',
      event: 'send.submitted',
      run: 'r_1',
      cmd: 'send',
      pid: 1,
      data: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, 'y'.repeat(300)])),
    }
    const line = serialize(record)
    // Small enough to land in one write, which is what makes concurrent
    // appends safe — and the event survives even though its detail did not.
    expect(Buffer.byteLength(line)).toBeLessThan(8_000)
    const parsed = JSON.parse(line) as LogRecord
    expect(parsed.event).toBe('send.submitted')
    expect(parsed.data).toMatchObject({ dropped: expect.any(String) })
  })
})

describe('rotation', () => {
  it('rotates at the byte cap and keeps only the configured files', () => {
    const env = sandbox()
    const logger = createLogger({ env, settings: { maxBytes: 700, maxFiles: 3 } })
    for (let i = 0; i < 60; i += 1) logger.info('cli.end', { i, pad: 'p'.repeat(50) })

    const usage = logsDiskUsage(env)
    expect(usage.files).toBe(3)
    expect(archiveLogPaths(env)).toHaveLength(2)
    // The whole point: bounded. Every retained file obeys the configured cap,
    // however long the agent runs.
    expect(usage.bytes).toBeLessThanOrEqual(3 * 700)
    for (const file of [activeLogPath(env), ...archiveLogPaths(env)]) {
      expect(statSync(file).size).toBeLessThanOrEqual(700)
    }
  })

  it('enforces the byte cap and preserves each record across overlapping processes', async () => {
    const env = sandbox()
    const workers = 4
    const recordsPerWorker = 50
    const maxBytes = 4_000
    const maxFiles = 100
    const startPath = path.join(env['XDG_STATE_HOME']!, 'rotation-start')
    // Four cold Vitest processes have to reach the barrier before any of them
    // writes, and a busy CI host schedules them far apart. The budget is shared,
    // so it bounds the whole rendezvous rather than each side of it.
    const deadline = Date.now() + 20_000
    const children = Array.from({ length: workers }, (_, worker) =>
      rotationWorker({ env, worker, records: recordsPerWorker, maxBytes, maxFiles, startPath, deadline }),
    )

    await waitUntil(() => children.every(({ readyPath }) => existsSync(readyPath)), deadline)
    writeFileSync(startPath, 'go')
    await Promise.all(children.map(({ done }) => done))

    const files = [activeLogPath(env), ...archiveLogPaths(env)]
    expect(files.length).toBeGreaterThan(1)
    // The stat/rotate/append transaction is cross-process: no writer gets to
    // consume budget another writer already claimed.
    for (const file of files) expect(statSync(file).size).toBeLessThanOrEqual(maxBytes)

    const seen = new Map<string, number>()
    let retainedRecords = 0
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const record = JSON.parse(line) as LogRecord
        if (record.event !== 'cli.end') continue
        retainedRecords += 1
        const key = `${String(record.data?.['worker'])}:${String(record.data?.['sequence'])}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
    }
    // Retention has room for every record, so neither a rotation nor an archive
    // name race may lose or duplicate one.
    expect(retainedRecords).toBe(workers * recordsPerWorker)
    expect(seen.size).toBe(workers * recordsPerWorker)
    // Name the offending records: a bare boolean would report a duplication bug
    // as "expected false to be true" and leave the next reader nothing to go on.
    expect([...seen].filter(([, count]) => count !== 1)).toEqual([])
  }, 90_000)
})

describe('failure isolation', () => {
  it('a sink that cannot write never throws at the caller', () => {
    const env = sandbox()
    // The logs directory's place is taken by a regular file, so every write
    // below fails. A command must not care.
    writeFileSync(path.join(env['XDG_STATE_HOME']!, 'notifai'), 'in the way')
    const logger = createLogger({ env })
    expect(() => logger.info('cli.end', { exit: 0 })).not.toThrow()
    expect(logger.enabled).toBe(false)
  })

  it('a long-lived process records again once a full disk has room, and a write cut short damages only its own line', () => {
    const env = sandbox()
    let clock = Date.parse('2026-10-27T14:02:00Z')
    const logger = createLogger({ env, now: () => clock, runId: 'r_hub', cmd: 'hub' })
    logger.info('hub.start', { outcome: 'listening' })
    // The disk filled mid-write: a record without its end, and a write that failed.
    writeFileSync(activeLogPath(env), `${readFileSync(activeLogPath(env), 'utf8')}{"v":1,"ts":"2026-10-27T14:02:30.000Z","event":"hub.ses`)
    const hold = path.join(env['XDG_STATE_HOME']!, 'notifai', 'logs')
    const moved = `${hold}.away`
    renameSync(hold, moved)
    writeFileSync(hold, 'full')
    logger.info('hub.session', { event: 'lost' })
    expect(logger.enabled).toBe(false)
    rmSync(hold)
    renameSync(moved, hold)
    clock += 60_000
    logger.info('hub.exchange', { event: 'restarted' })
    expect(logger.enabled).toBe(true)
    expect(readLogRecords(env).records.map((record) => record.event)).toEqual(['hub.start', 'hub.exchange'])
  })
})

describe('reading', () => {
  function seed(env: NodeJS.ProcessEnv): void {
    const logger = createLogger({ env, runId: 'r_1', cmd: 'send' })
    logger.bind({ project: 'alpha' })
    logger.info('send.submitted', { request_id: 'req_alpha' })
    logger.error('cli.error', { message: 'boom' })
    const other = createLogger({ env, runId: 'r_2', cmd: 'ask' })
    other.bind({ project: 'beta' })
    other.info('ask.registered', { request_id: 'req_beta' })
  }

  it('returns records oldest first, so the result reads forwards', () => {
    const env = sandbox()
    seed(env)
    const { records } = readLogRecords(env)
    expect(records.map((record) => record.event)).toEqual([
      'send.submitted',
      'cli.error',
      'ask.registered',
    ])
  })
})

describe('rendering', () => {
  it('puts the fixed columns first so lines can be scanned, not read', () => {
    const line = renderRecord({
      v: 1,
      ts: '2026-08-11T12:04:31.123Z',
      level: 'info',
      event: 'hook.gate',
      run: 'r_1',
      cmd: 'hook stop',
      pid: 1,
      data: { verdict: 'held', reason: 'question-notifications-off', source: 'default' },
    })
    expect(line).toContain('2026-08-11 12:04:31')
    expect(line).toContain('hook.gate')
    expect(line).toContain('reason=question-notifications-off')
    expect(line).toContain('source=default')
  })
})

describe('logging inside a hook', () => {
  it('never waits for a busy log lock and keeps every record', () => {
    const env = sandbox()
    const logger = createLogger({ env, lockWaitMs: 0 })
    logger.info('hook.start', { hook: 'user-prompt-submit' })
    const started = Date.now()
    // Another writer holds the shared lock for the whole of this hook's records.
    withFileLock(`${activeLogPath(env)}.lock`, () => {
      logger.info('hook.end', { hook: 'user-prompt-submit', outcome: 'busy-log' })
      logger.error('hook.end', { hook: 'user-prompt-submit', outcome: 'still-writing' })
    })
    expect(Date.now() - started).toBeLessThan(500)
    expect(logger.enabled).toBe(true)
    logger.info('hook.end', { hook: 'user-prompt-submit', outcome: 'after' })
    expect(lines(env).map((record) => record.data?.['outcome'] ?? record.event)).toEqual([
      'hook.start', 'busy-log', 'still-writing', 'after',
    ])
  })
})
