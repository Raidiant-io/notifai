import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { LOG_SCHEMA_VERSION, activeLogPath, createLogger, type LogRecord } from './logging.js'
import { encodeFeedbackSlice, packFeedbackSlice } from './pack-feedback-slice.js'

function sandbox(): NodeJS.ProcessEnv {
  return { XDG_STATE_HOME: mkdtempSync(path.join(os.tmpdir(), 'notifai-feedback-')) }
}

function writeLog(env: NodeJS.ProcessEnv, records: LogRecord[]): void {
  const file = activeLogPath(env)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, {
    mode: 0o600,
  })
}

function record(overrides: Partial<LogRecord> & Pick<LogRecord, 'ts'>): LogRecord {
  return {
    v: 1,
    level: 'info',
    event: 'cli.end',
    run: 'r_1',
    cmd: 'send',
    pid: 1,
    ...overrides,
  }
}

describe('packFeedbackSlice', () => {
  it('returns an empty result with no gzip when there is no log', () => {
    const result = packFeedbackSlice(sandbox())

    expect(result.record_count).toBe(0)
    expect(result.records).toEqual([])
    expect(result.jsonl).toBe('')
    expect(result.gzip).toBeUndefined()
    expect(result.uncompressed_bytes).toBe(0)
    expect(result.compressed_bytes).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.consentSummary.toLowerCase()).toMatch(/credential/)
    expect(result.consentSummary.toLowerCase()).toMatch(/title/)
    expect(result.consentSummary.toLowerCase()).toMatch(/answer/)
  })

  it('packs records inside the default 24-hour window and drops older ones', () => {
    const env = sandbox()
    const now = Date.parse('2026-08-13T12:00:00.000Z')
    writeLog(env, [
      record({ ts: '2026-08-12T11:00:00.000Z', data: { which: 'too-old' } }),
      record({ ts: '2026-08-12T13:00:00.000Z', data: { which: 'kept' } }),
    ])

    const result = packFeedbackSlice(env, { now })

    expect(result.record_count).toBe(1)
    expect(result.records[0]?.data).toMatchObject({ which: 'kept' })
    expect(result.since).toBe(Date.parse('2026-08-12T12:00:00.000Z'))
    expect(result.until).toBe(now)
    expect(result.jsonl).toContain('kept')
    expect(result.jsonl).not.toContain('too-old')
    expect(result.gzip).toBeDefined()
    expect(result.uncompressed_bytes).toBe(Buffer.byteLength(result.jsonl))
    expect(result.compressed_bytes).toBe(result.gzip!.length)
    expect(result.truncated).toBe(false)
  })

  it('gives consent copy that names redacted credentials, titles, answers, window, and size', () => {
    const env = sandbox()
    const now = Date.parse('2026-08-13T12:00:00.000Z')
    writeLog(env, [record({ ts: '2026-08-13T11:00:00.000Z' })])

    const result = packFeedbackSlice(env, { now })
    const copy = result.consentSummary.toLowerCase()

    expect(copy).toMatch(/credential/)
    expect(copy).toMatch(/already removed|already redacted|redacted/)
    expect(copy).toMatch(/title/)
    expect(copy).toMatch(/answer/)
    expect(result.consentSummary).toContain('2026-08-12T12:00:00.000Z')
    expect(result.consentSummary).toContain('2026-08-13T12:00:00.000Z')
    expect(result.consentSummary).toContain(String(result.uncompressed_bytes))
    expect(result.consentSummary).toContain(String(result.compressed_bytes))
    expect(result.consentSummary).toContain(String(result.record_count))
  })

  it('applies extra log query filters on top of the window', () => {
    const env = sandbox()
    const now = Date.parse('2026-08-13T12:00:00.000Z')
    writeLog(env, [
      record({ ts: '2026-08-13T11:00:00.000Z', event: 'cli.end', data: { which: 'end' } }),
      record({ ts: '2026-08-13T11:01:00.000Z', event: 'cli.error', data: { which: 'error' } }),
    ])

    const result = packFeedbackSlice(env, { now, event: ['cli.error'] })

    expect(result.record_count).toBe(1)
    expect(result.records[0]?.event).toBe('cli.error')
    expect(result.records[0]?.data).toMatchObject({ which: 'error' })
  })

  it('drops oldest records until the uncompressed JSONL cap holds', () => {
    const env = sandbox()
    const now = Date.parse('2026-08-13T12:00:00.000Z')
    const start = Date.parse('2026-08-13T10:00:00.000Z')
    const pad = 'x'.repeat(2000)
    writeLog(
      env,
      Array.from({ length: 200 }, (_, sequence) =>
        record({
          ts: new Date(start + sequence * 1000).toISOString(),
          data: { sequence, pad },
        }),
      ),
    )

    const result = packFeedbackSlice(env, { now })
    const sequences = result.records.map((entry) => entry.data?.['sequence'])

    expect(result.uncompressed_bytes).toBeLessThanOrEqual(256 * 1024)
    expect(result.compressed_bytes).toBeLessThanOrEqual(128 * 1024)
    expect(result.truncated).toBe(true)
    expect(result.record_count).toBeGreaterThan(0)
    expect(sequences[0]).toBeGreaterThan(0)
    expect(sequences.at(-1)).toBe(199)
  })

  it('drops oldest records until the gzip cap holds', () => {
    const env = sandbox()
    const now = Date.parse('2026-08-13T12:00:00.000Z')
    const start = Date.parse('2026-08-13T10:00:00.000Z')
    const seeded = Array.from({ length: 80 }, (_, sequence) =>
      record({
        ts: new Date(start + sequence * 1000).toISOString(),
        data: { sequence, pad: randomBytes(1800).toString('base64') },
      }),
    )
    writeLog(env, seeded)

    const result = packFeedbackSlice(env, { now })
    const sequences = result.records.map((entry) => entry.data?.['sequence'])

    expect(result.uncompressed_bytes).toBeLessThanOrEqual(256 * 1024)
    expect(result.compressed_bytes).toBeLessThanOrEqual(128 * 1024)
    expect(result.truncated).toBe(true)
    expect(result.record_count).toBeGreaterThan(0)
    expect(result.record_count).toBeLessThan(seeded.length)
    expect(sequences[0]).toBeGreaterThan(0)
    expect(sequences.at(-1)).toBe(79)
  })

  it('encodes the gzip slice as a gzip+base64 wire payload', () => {
    const env = sandbox()
    const now = Date.parse('2026-08-13T12:00:00.000Z')
    writeLog(env, [record({ ts: '2026-08-13T11:00:00.000Z', data: { which: 'wire' } })])

    const packed = packFeedbackSlice(env, { now })
    const wire = encodeFeedbackSlice(packed)

    expect(wire).toEqual({
      encoding: 'gzip+base64',
      bytes: packed.gzip!.toString('base64'),
      uncompressed_bytes: packed.uncompressed_bytes,
      compressed_bytes: packed.compressed_bytes,
      record_count: packed.record_count,
      truncated: false,
      since: '2026-08-12T12:00:00.000Z',
      until: '2026-08-13T12:00:00.000Z',
      schema_version: packed.schema_version,
    })
    expect(gunzipSync(Buffer.from(wire!.bytes, 'base64')).toString('utf8')).toBe(packed.jsonl)
    expect(encodeFeedbackSlice(packFeedbackSlice(sandbox()))).toBeUndefined()
  })

  it('honours an explicit since instead of the 24-hour default', () => {
    const env = sandbox()
    const now = Date.parse('2026-08-13T12:00:00.000Z')
    writeLog(env, [
      record({ ts: '2026-08-10T12:00:00.000Z', data: { which: 'old' } }),
      record({ ts: '2026-08-13T11:00:00.000Z', data: { which: 'new' } }),
    ])

    const result = packFeedbackSlice(env, {
      now,
      since: Date.parse('2026-08-10T00:00:00.000Z'),
    })

    expect(result.records.map((entry) => entry.data?.['which'])).toEqual(['old', 'new'])
    expect(result.since).toBe(Date.parse('2026-08-10T00:00:00.000Z'))
  })

  it('packs records written by the logger and skips a damaged line', () => {
    const env = sandbox()
    const logger = createLogger({ env, now: () => Date.parse('2026-08-13T11:30:00.000Z') })
    logger.info('cli.end', { which: 'first' })
    appendFileSync(activeLogPath(env), 'not json at all\n')
    createLogger({ env, now: () => Date.parse('2026-08-13T11:31:00.000Z') }).info('cli.end', {
      which: 'second',
    })

    const result = packFeedbackSlice(env, { now: Date.parse('2026-08-13T12:00:00.000Z') })

    expect(result.schema_version).toBe(LOG_SCHEMA_VERSION)
    expect(result.record_count).toBe(2)
    expect(result.records.map((entry) => entry.data?.['which'])).toEqual(['first', 'second'])
    expect(result.truncated).toBe(false)
  })
})
