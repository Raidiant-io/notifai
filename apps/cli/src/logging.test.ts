import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LOG_SCHEMA_VERSION,
  activeLogPath,
  archiveLogPaths,
  createLogger,
  logsDiskUsage,
  nullLogger,
  readLogRecords,
  renderRecord,
  serialize,
  shape,
  type LogRecord,
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

  it('carries the project and session once bound', () => {
    const env = sandbox()
    const logger = createLogger({ env })
    logger.bind({ project: 'notifai', session: 'sess-1' })
    logger.info('hook.start', {})
    expect(lines(env)[0]).toMatchObject({ project: 'notifai', session: 'sess-1' })
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

  it('drops debug below debug, and keeps it at debug', () => {
    const quiet = sandbox()
    createLogger({ env: quiet, settings: { level: 'info' } }).debug('http.call', {})
    expect(logsDiskUsage(quiet).files).toBe(0)

    const loud = sandbox()
    createLogger({ env: loud, settings: { level: 'debug' } }).debug('http.call', {})
    expect(lines(loud)).toHaveLength(1)
  })

  it('keeps errors at the error level and nothing else', () => {
    const env = sandbox()
    const logger = createLogger({ env, settings: { level: 'error' } })
    logger.info('cli.end', {})
    logger.error('cli.error', {})
    expect(lines(env).map((record) => record.event)).toEqual(['cli.error'])
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

  it('redacts by key name regardless of the value', () => {
    expect(shape({ api_key: 12345, token: null, other: 'ok' })).toEqual({
      api_key: '[redacted]',
      token: '[redacted]',
      other: 'ok',
    })
  })

  it('truncates a long string instead of carrying it whole', () => {
    const shaped = shape({ body: 'x'.repeat(1000) }) as { body: string }
    expect(shaped.body.length).toBeLessThan(500)
    expect(shaped.body).toContain('+600 chars')
  })

  it('refuses to recurse for ever into a cyclic object', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(() => JSON.stringify(shape(cyclic))).not.toThrow()
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
    // The whole point: bounded. Three files of 700 bytes cannot fill a disk
    // however long the agent runs.
    expect(usage.bytes).toBeLessThan(3 * 700 + 500)
  })

  it('leaves a marker in the fresh file so a gap is explained, not inferred', () => {
    const env = sandbox()
    const logger = createLogger({ env, settings: { maxBytes: 400, maxFiles: 3 } })
    for (let i = 0; i < 20; i += 1) logger.info('cli.end', { i, pad: 'p'.repeat(40) })
    expect(lines(env).some((record) => record.event === 'log.rotated')).toBe(true)
  })

  it('keeps only the active file when asked for one', () => {
    const env = sandbox()
    const logger = createLogger({ env, settings: { maxBytes: 300, maxFiles: 1 } })
    for (let i = 0; i < 30; i += 1) logger.info('cli.end', { i, pad: 'p'.repeat(40) })
    expect(archiveLogPaths(env)).toHaveLength(0)
    expect(logsDiskUsage(env).files).toBe(1)
  })

  it('does not lose an archive when two processes rotate at once', () => {
    // Two loggers over one directory is exactly the real case: a hook and a
    // send, or two worktrees, racing on the same file.
    const env = sandbox()
    const first = createLogger({ env, settings: { maxBytes: 500, maxFiles: 10 }, runId: 'r_a' })
    const second = createLogger({ env, settings: { maxBytes: 500, maxFiles: 10 }, runId: 'r_b' })
    for (let i = 0; i < 40; i += 1) {
      first.info('cli.end', { i, pad: 'a'.repeat(40) })
      second.info('cli.end', { i, pad: 'b'.repeat(40) })
    }

    // Whatever order the two rotations landed in, every line in every file is
    // still a complete record — no interleaved halves, no truncation.
    const files = [activeLogPath(env), ...archiveLogPaths(env)]
    let total = 0
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        expect(() => JSON.parse(line)).not.toThrow()
        total += 1
      }
    }
    expect(total).toBeGreaterThan(0)
    expect(readdirSync(path.dirname(activeLogPath(env))).length).toBeGreaterThan(1)
  })
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

  it('the null logger accepts everything and records nothing', () => {
    const logger = nullLogger()
    expect(() => {
      logger.info('cli.end', {})
      logger.bind({ cmd: 'x' })
      logger.adopt({ level: 'debug' })
    }).not.toThrow()
    expect(logger.enabled).toBe(false)
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

  it('is bounded, and says when there is more behind it', () => {
    const env = sandbox()
    seed(env)
    const { records, more } = readLogRecords(env, { limit: 1 })
    // The newest, not the oldest: a limit exists to answer "what just
    // happened", so cutting the recent end would defeat it.
    expect(records.map((record) => record.event)).toEqual(['ask.registered'])
    expect(more).toBe(true)
  })

  it('filters by run, project, event, and severity', () => {
    const env = sandbox()
    seed(env)
    expect(readLogRecords(env, { run: 'r_1' }).records).toHaveLength(2)
    expect(readLogRecords(env, { project: 'beta' }).records).toHaveLength(1)
    expect(readLogRecords(env, { event: ['cli.error'] }).records).toHaveLength(1)
    expect(readLogRecords(env, { level: 'error' }).records.map((r) => r.event)).toEqual(['cli.error'])
  })

  it('finds every record touching one notification request', () => {
    const env = sandbox()
    seed(env)
    const { records } = readLogRecords(env, { request: 'req_alpha' })
    expect(records).toHaveLength(1)
    expect(records[0]!.event).toBe('send.submitted')
  })

  it('honours a time floor', () => {
    const env = sandbox()
    const early = createLogger({ env, now: () => Date.parse('2026-08-01T00:00:00Z') })
    early.info('cli.end', { when: 'old' })
    const late = createLogger({ env, now: () => Date.parse('2026-08-11T00:00:00Z') })
    late.info('cli.end', { when: 'new' })

    const { records } = readLogRecords(env, { since: Date.parse('2026-08-10T00:00:00Z') })
    expect(records).toHaveLength(1)
    expect(records[0]!.data).toMatchObject({ when: 'new' })
  })

  it('reads across archives when the active file is not enough', () => {
    const env = sandbox()
    const logger = createLogger({ env, settings: { maxBytes: 500, maxFiles: 5 } })
    for (let i = 0; i < 30; i += 1) logger.info('cli.end', { i })
    expect(archiveLogPaths(env).length).toBeGreaterThan(0)
    const { records, files } = readLogRecords(env, { limit: 30, event: ['cli.end'] })
    expect(files.length).toBeGreaterThan(1)
    expect(records.length).toBeGreaterThan(lines(env).filter((r) => r.event === 'cli.end').length)
  })

  it('skips a damaged line instead of throwing away the file', () => {
    const env = sandbox()
    seed(env)
    // A half-written line is what a crashed process leaves behind, and a
    // reader that dies on it loses every good record around it.
    appendFileSync(activeLogPath(env), '{"v":1,"ts":"2026-0\n')
    appendFileSync(activeLogPath(env), 'not json at all\n')
    expect(readLogRecords(env).records).toHaveLength(3)
  })

  it('reports nothing at all rather than failing when there is no log', () => {
    expect(readLogRecords(sandbox())).toMatchObject({ records: [], more: false })
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
      data: { verdict: 'held', reason: 'user-present', idle_seconds: 4 },
    })
    expect(line).toContain('2026-08-11 12:04:31')
    expect(line).toContain('hook.gate')
    expect(line).toContain('reason=user-present')
    expect(line).toContain('idle_seconds=4')
  })

  it('stays on one line whatever the payload', () => {
    const line = renderRecord({
      v: 1,
      ts: '2026-08-11T12:04:31.123Z',
      level: 'error',
      event: 'cli.error',
      run: 'r_1',
      cmd: 'send',
      pid: 1,
      data: { message: 'first\nsecond\nthird', big: 'z'.repeat(300) },
    })
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThan(200)
  })
})
