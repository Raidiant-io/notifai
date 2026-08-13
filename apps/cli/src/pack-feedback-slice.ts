/**
 * Consented, bounded slice of the local log for a later feedback send.
 *
 * This module packs. It does not upload. A caller that wants a report on
 * the wire asks here for the bytes and the consent copy, then decides
 * whether to send them.
 */
import { gzipSync } from 'node:zlib'
import {
  LOG_SCHEMA_VERSION,
  readLogRecords,
  type LogQuery,
  type LogRecord,
} from './logging.js'

export const FEEDBACK_SLICE_UNCOMPRESSED_CAP = 256 * 1024
export const FEEDBACK_SLICE_COMPRESSED_CAP = 128 * 1024
export const FEEDBACK_SLICE_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

/** High enough that on-disk rotation, not this number, bounds a full-window read. */
const FULL_WINDOW_READ_LIMIT = 1_000_000

export interface PackFeedbackSliceOptions extends LogQuery {
  /** Epoch ms. Defaults to now. Tests freeze the window with this. */
  now?: number
}

export interface PackedFeedbackSlice {
  records: LogRecord[]
  jsonl: string
  gzip?: Buffer
  uncompressed_bytes: number
  compressed_bytes: number
  record_count: number
  truncated: boolean
  since: number
  until: number
  schema_version: number
  consentSummary: string
}

export interface FeedbackSliceWire {
  encoding: 'gzip+base64'
  bytes: string
  uncompressed_bytes: number
  compressed_bytes: number
  record_count: number
  truncated: boolean
  since: string
  until: string
  schema_version: number
}

/** Wire form. Empty slices have nothing to encode. */
export function encodeFeedbackSlice(slice: PackedFeedbackSlice): FeedbackSliceWire | undefined {
  if (slice.gzip === undefined) return undefined
  return {
    encoding: 'gzip+base64',
    bytes: slice.gzip.toString('base64'),
    uncompressed_bytes: slice.uncompressed_bytes,
    compressed_bytes: slice.compressed_bytes,
    record_count: slice.record_count,
    truncated: slice.truncated,
    since: new Date(slice.since).toISOString(),
    until: new Date(slice.until).toISOString(),
    schema_version: slice.schema_version,
  }
}

export function packFeedbackSlice(
  env: NodeJS.ProcessEnv = process.env,
  options: PackFeedbackSliceOptions = {},
): PackedFeedbackSlice {
  const { now, since: sinceOption, limit, ...filters } = options
  const until = now ?? Date.now()
  const since = sinceOption ?? until - FEEDBACK_SLICE_DEFAULT_WINDOW_MS
  const { records } = readLogRecords(env, {
    ...filters,
    since,
    limit: limit ?? FULL_WINDOW_READ_LIMIT,
  })

  if (records.length === 0) {
    return emptySlice(since, until)
  }

  const packed = fitToCaps(records)
  if (packed === null) {
    return emptySlice(since, until)
  }

  return {
    records: packed.records,
    jsonl: packed.jsonl,
    gzip: packed.gzip,
    uncompressed_bytes: packed.uncompressedBytes,
    compressed_bytes: packed.gzip.length,
    record_count: packed.records.length,
    truncated: packed.truncated,
    since,
    until,
    schema_version: LOG_SCHEMA_VERSION,
    consentSummary: consentSummary({
      since,
      until,
      recordCount: packed.records.length,
      uncompressedBytes: packed.uncompressedBytes,
      compressedBytes: packed.gzip.length,
    }),
  }
}

function fitToCaps(records: LogRecord[]): {
  records: LogRecord[]
  jsonl: string
  gzip: Buffer
  uncompressedBytes: number
  truncated: boolean
} | null {
  const lines = records.map((record) => JSON.stringify(record))
  let start = 0
  let truncated = false
  while (start < lines.length) {
    const jsonl = toJsonl(lines.slice(start))
    const uncompressedBytes = Buffer.byteLength(jsonl)
    if (uncompressedBytes > FEEDBACK_SLICE_UNCOMPRESSED_CAP) {
      start += 1
      truncated = true
      continue
    }
    const gzip = gzipSync(jsonl)
    if (gzip.length <= FEEDBACK_SLICE_COMPRESSED_CAP) {
      return {
        records: records.slice(start),
        jsonl,
        gzip,
        uncompressedBytes,
        truncated,
      }
    }
    start += 1
    truncated = true
  }
  return null
}

function emptySlice(since: number, until: number): PackedFeedbackSlice {
  return {
    records: [],
    jsonl: '',
    uncompressed_bytes: 0,
    compressed_bytes: 0,
    record_count: 0,
    truncated: false,
    since,
    until,
    schema_version: LOG_SCHEMA_VERSION,
    consentSummary: consentSummary({
      since,
      until,
      recordCount: 0,
      uncompressedBytes: 0,
      compressedBytes: 0,
    }),
  }
}

function toJsonl(lines: string[]): string {
  if (lines.length === 0) return ''
  return `${lines.join('\n')}\n`
}

function consentSummary(input: {
  since: number
  until: number
  recordCount: number
  uncompressedBytes: number
  compressedBytes: number
}): string {
  const from = new Date(input.since).toISOString()
  const to = new Date(input.until).toISOString()
  return (
    `About to send ${String(input.recordCount)} log records from ${from} to ${to} ` +
    `(${String(input.uncompressedBytes)} bytes uncompressed, ${String(input.compressedBytes)} bytes compressed). ` +
    'Credentials are already removed. Notification titles and the user\'s answers are in the log.'
  )
}
