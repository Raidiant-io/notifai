/** Read typed lifecycle and optional question records from an owned native transcript. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import { configHome } from './install-hooks.js'
import { newJsonRecord, traverseJsonByte, validJsonRecord, type JsonRecordState } from './bounded-json-record.js'

export interface NativeTurnSnapshot {
  file: string
  identity: string
  size: number
  latest: { id: string; offset: number; ended: boolean; outcome?: 'completed' | 'aborted' }
  positions: Map<string, number>
  /** Only populated by explicit question observation, never by activity polling. */
  questions?: NativeQuestionEmission[]
}

export interface NativeQuestionEmission {
  /** Byte position of the actual tool call, used to reject pre-registration calls. */
  offset: number
  turn_id: string
  call_id: string
  index: number
  title: string
  options?: string[]
  accepted: boolean
}

const HEADER_BYTES = 64 * 1024
const TAIL_BYTES = 8 * 1024 * 1024

interface ActivityCheckpoint {
  schema: 1
  sessionId: string
  file: string
  identity: string
  through: number
  observedSize: number
  mtimeMs: number
  prefixBytes: number
  prefixHash: string
  boundaryHash: string
  /** Legacy cursors resume sequentially at through, a proven record boundary. */
  seekTail?: boolean
  traversal?: { start: number; boundaryHash: string; prefixBytes: number; prefixHash: string; state: JsonRecordState; hash: string }
  latest?: NativeTurnSnapshot['latest']
  marker?: { offset: number; bytes: number; hash: string }
  positions: Array<[string, number]>
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const checkpointPath = (sessionId: string, env: NodeJS.ProcessEnv): string =>
  path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.native-cursor`)

function readCheckpoint(file: string): ActivityCheckpoint | undefined {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > HEADER_BYTES) return undefined
    const value = JSON.parse(readFileSync(file, 'utf8')) as ActivityCheckpoint
    const offset = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
    if (value.schema !== 1 || typeof value.sessionId !== 'string' || typeof value.file !== 'string' ||
        typeof value.identity !== 'string' || !offset(value.through) || !offset(value.observedSize) ||
        value.through > value.observedSize || !Number.isFinite(value.mtimeMs) ||
        !offset(value.prefixBytes) || value.prefixBytes > Math.min(HEADER_BYTES, value.through) ||
        (value.seekTail !== undefined && typeof value.seekTail !== 'boolean') ||
        !/^[a-f0-9]{64}$/.test(value.prefixHash) || !/^[a-f0-9]{64}$/.test(value.boundaryHash) ||
        !Array.isArray(value.positions) || value.positions.length > 32 ||
        value.positions.some(entry => !Array.isArray(entry) || entry.length !== 2 ||
          typeof entry[0] !== 'string' || !offset(entry[1]) || entry[1] >= value.through)) return undefined
    if (value.latest !== undefined && (typeof value.latest.id !== 'string' || !offset(value.latest.offset) ||
        value.latest.offset >= value.through || typeof value.latest.ended !== 'boolean' ||
        (value.latest.ended && !['completed', 'aborted'].includes(value.latest.outcome ?? '')) ||
        !value.positions.some(([id, at]) => id === value.latest!.id && at === value.latest!.offset) ||
        value.marker === undefined || !offset(value.marker.offset) || !offset(value.marker.bytes) ||
        value.marker.bytes === 0 || value.marker.bytes > HEADER_BYTES ||
        value.marker.offset + value.marker.bytes > value.through ||
        !/^[a-f0-9]{64}$/.test(value.marker.hash))) return undefined
    if (value.traversal !== undefined) {
      const t = value.traversal
      if (t === null || !offset(t.start) || t.start >= value.through || value.seekTail === true ||
          (value.marker !== undefined && value.marker.offset + value.marker.bytes > t.start) ||
          !offset(t.prefixBytes) || t.prefixBytes !== Math.min(HEADER_BYTES, value.through - t.start) ||
          !/^[a-f0-9]{64}$/.test(t.prefixHash) ||
          !validJsonRecord(t.state) || !/^[a-f0-9]{64}$/.test(t.boundaryHash) ||
          t.hash !== digest(Buffer.from(JSON.stringify({ start: t.start, boundaryHash: t.boundaryHash,
            prefixBytes: t.prefixBytes, prefixHash: t.prefixHash, state: t.state })))) return undefined
    }
    return value
  } catch { return undefined }
}

/** Bounded filename discovery for an existing owner during an explicit update.
 * The reader below still verifies native metadata; filenames are not identity.
 */
export function findNativeTranscript(sessionId: string, env: NodeJS.ProcessEnv): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null
  const matches: string[] = []
  let remaining = 50_000
  const visit = (directory: string, depth: number): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (--remaining < 0) throw new Error('discovery-bound')
      const file = path.join(directory, entry.name)
      if (entry.isDirectory() && depth < 3) visit(file, depth + 1)
      else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) matches.push(file)
    }
  }
  try {
    visit(path.join(configHome(env, 'CODEX_HOME', '.codex'), 'sessions'), 0)
    return matches.length === 1 ? matches[0]! : null
  } catch { return null }
}

/** Unknown, replaced, partial or unowned records never supply activity evidence. */
export function readNativeTurnSnapshot(
  file: unknown, sessionId: string, env: NodeJS.ProcessEnv,
): NativeTurnSnapshot | null {
  const checkpoint = checkpointPath(sessionId, env)
  try {
    return withFileLock(`${checkpoint}.lock`, () => {
      const observed = readNativeTranscript(file, sessionId, env, false, false, checkpoint)
      return observed !== null && 'latest' in observed ? observed : null
    }, { waitMs: 500 })
  } catch { return null }
}

/** Explicit update recovery may catch up an existing transcript before handing
 * over its resident writer. Ordinary polling still performs only one chunk.
 * No-progress, lost ownership and the work budget all stop recovery as unknown.
 */
export async function recoverNativeTurnSnapshot(
  file: unknown, sessionId: string, env: NodeJS.ProcessEnv, stillOwned: () => boolean,
): Promise<NativeTurnSnapshot | null> {
  const until = performance.now() + 2_000
  let previous: ActivityCheckpoint | undefined
  for (let probes = 0; probes < 32 && performance.now() < until && stillOwned(); probes++) {
    const snapshot = readNativeTurnSnapshot(file, sessionId, env)
    if (!stillOwned()) return null
    if (snapshot !== null) return snapshot
    const progress = readCheckpoint(checkpointPath(sessionId, env))
    if (progress === undefined || (previous !== undefined &&
        (progress.identity !== previous.identity ||
          (progress.through <= previous.through && progress.seekTail === previous.seekTail)))) return null
    previous = progress
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return null
}

/** Observe actual native async-question calls plus their acceptance receipts.
 * User messages, quoted examples and injected app-answer envelopes are never
 * question emissions. This reads only the same owned, stable bounded tail.
 */
export function readNativeQuestionSnapshot(file: unknown, sessionId: string, env: NodeJS.ProcessEnv): NativeTurnSnapshot | null {
  const observed = readNativeTranscript(file, sessionId, env, false, true)
  return observed !== null && 'latest' in observed ? observed : null
}

/** Ownership can be proved even when a long turn exceeds the activity bound. */
export function nativeTranscriptOwned(file: unknown, sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return readNativeTranscript(file, sessionId, env, true) !== null
}

function readNativeTranscript(
  file: unknown, sessionId: string, env: NodeJS.ProcessEnv, identityOnly: boolean, includeQuestions = false,
  checkpointFile?: string,
): NativeTurnSnapshot | Pick<NativeTurnSnapshot, 'file' | 'identity'> | null {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null
  let fd: number | undefined
  try {
    const sessions = realpathSync(path.join(configHome(env, 'CODEX_HOME', '.codex'), 'sessions'))
    const canonical = realpathSync(file)
    if (lstatSync(file).isSymbolicLink() || !canonical.startsWith(`${sessions}${path.sep}`)) return null
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size === 0) return null
    const read = (at: number, count: number): Buffer => {
      const bytes = Buffer.alloc(count)
      const length = readSync(fd!, bytes, 0, count, at)
      return bytes.subarray(0, length)
    }
    const header = read(0, Math.min(HEADER_BYTES, stat.size)).toString('utf8')
    const newline = header.indexOf('\n')
    if (newline < 0) return null
    const meta = JSON.parse(header.slice(0, newline)) as { type?: string; payload?: { id?: string; source?: unknown } }
    if (meta.type !== 'session_meta' || meta.payload?.id !== sessionId ||
        !['cli', 'vscode', 'exec'].includes(String(meta.payload.source))) return null
    if (identityOnly) return { file: canonical, identity: `${stat.dev}:${stat.ino}` }
    const identity = `${stat.dev}:${stat.ino}`
    let checkpoint = checkpointFile === undefined ? undefined : readCheckpoint(checkpointFile)
    if (checkpoint !== undefined && (checkpoint.sessionId !== sessionId || checkpoint.file !== canonical ||
        checkpoint.identity !== identity || checkpoint.observedSize > stat.size ||
        (checkpoint.observedSize === stat.size && checkpoint.mtimeMs !== stat.mtimeMs) ||
        digest(read(0, checkpoint.prefixBytes)) !== checkpoint.prefixHash ||
        digest(read(Math.max(0, checkpoint.through - HEADER_BYTES), Math.min(HEADER_BYTES, checkpoint.through))) !== checkpoint.boundaryHash ||
        (checkpoint.traversal !== undefined && digest(read(Math.max(0, checkpoint.traversal.start - HEADER_BYTES),
          Math.min(HEADER_BYTES, checkpoint.traversal.start))) !== checkpoint.traversal.boundaryHash) ||
        (checkpoint.traversal !== undefined && digest(read(checkpoint.traversal.start,
          checkpoint.traversal.prefixBytes)) !== checkpoint.traversal.prefixHash) ||
        (checkpoint.marker !== undefined && digest(read(checkpoint.marker.offset, checkpoint.marker.bytes)) !== checkpoint.marker.hash))) {
      checkpoint = undefined
    }
    if (checkpointFile !== undefined) {
      // Activity never seeks across unseen bytes. Unlike the question reader,
      // it can pause anywhere in a JSON record and retain only bounded grammar
      // state. A legacy seekTail checkpoint is already at a record boundary.
      const at = checkpoint?.through ?? 0
      const count = Math.min(TAIL_BYTES, stat.size - at)
      const bytes = read(at, count)
      if (bytes.length !== count) return null
      let start = checkpoint?.traversal?.start ?? at
      let state = checkpoint?.traversal?.state ?? newJsonRecord()
      let latest = checkpoint?.latest === undefined ? undefined : { ...checkpoint.latest }
      let marker = checkpoint?.marker
      const positions = new Map<string, number>(checkpoint?.positions)
      for (let i = 0; i < bytes.length; i++) {
        if (!traverseJsonByte(state, bytes[i]!)) continue
        const through = at + i + 1
        if (state.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(state.payloadType ?? '')) {
          // Lifecycle evidence is deliberately small, independently parseable,
          // and retained as a hash-checked marker, never as scanner guesses.
          if (through - start > HEADER_BYTES) return null
          const line = read(start, through - start)
          if (line.length !== through - start) return null
          const record = JSON.parse(line.toString('utf8')) as { payload?: { type?: string; turn_id?: string } }
          const event = record.payload
          if (event?.type === 'task_started' && typeof event.turn_id === 'string') {
            latest = { id: event.turn_id, offset: start, ended: false }
            marker = { offset: start, bytes: line.length, hash: digest(line) }
            positions.set(event.turn_id, start)
            if (positions.size > 32) positions.delete(positions.keys().next().value!)
          } else if (latest !== undefined && event?.turn_id === latest.id &&
              ['task_complete', 'turn_aborted'].includes(event.type ?? '')) {
            latest.ended = true
            latest.outcome = event.type === 'turn_aborted' ? 'aborted' : 'completed'
            marker = { offset: start, bytes: line.length, hash: digest(line) }
          }
        }
        start = through
        state = newJsonRecord()
      }
      const after = fstatSync(fd)
      const current = lstatSync(canonical)
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || current.isSymbolicLink() ||
          current.dev !== stat.dev || current.ino !== stat.ino) return null
      const through = at + bytes.length
      if (checkpoint === undefined || through > checkpoint.through || checkpoint.seekTail === true) {
        const prefixBytes = Math.min(HEADER_BYTES, through)
        const traversal = start === through ? undefined : {
          start, boundaryHash: digest(read(Math.max(0, start - HEADER_BYTES), Math.min(HEADER_BYTES, start))),
          prefixBytes: Math.min(HEADER_BYTES, through - start),
          prefixHash: digest(read(start, Math.min(HEADER_BYTES, through - start))), state,
        }
        const next: ActivityCheckpoint = {
          schema: 1, sessionId, file: canonical, identity, through, observedSize: stat.size, mtimeMs: stat.mtimeMs,
          prefixBytes, prefixHash: digest(read(0, prefixBytes)),
          boundaryHash: digest(read(Math.max(0, through - HEADER_BYTES), Math.min(HEADER_BYTES, through))),
          ...(traversal === undefined ? {} : { traversal: { ...traversal, hash: digest(Buffer.from(JSON.stringify(traversal))) } }),
          ...(latest === undefined ? {} : { latest }), ...(marker === undefined ? {} : { marker }), positions: [...positions],
        }
        atomicWriteFileSync(checkpointFile, `${JSON.stringify(next)}\n`)
      }
      if (latest === undefined || through !== stat.size || start !== through) return null
      return { file: canonical, identity, size: stat.size, latest, positions }
    }
    // Question binding deliberately retains its full bounded-tail semantics.
    const at = Math.max(0, stat.size - TAIL_BYTES)
    const count = Math.min(TAIL_BYTES, stat.size - at)
    const bytes = read(at, count)
    if (bytes.length !== count) return null
    // A trailing partial record may be a newer start: do not report an older one.
    if (bytes.at(-1) !== 10) return null
    const limit = bytes.length
    let offset = at === 0 ? 0 : bytes.indexOf(10) + 1
    if (at > 0 && offset === 0) return null
    let latest: NativeTurnSnapshot['latest'] | undefined
    const positions = new Map<string, number>()
    const questions: NativeQuestionEmission[] = []
    const questionCalls = new Set<string>()
    const outputs = new Map<string, boolean>()
    while (offset < limit) {
      const end = bytes.indexOf(10, offset)
      if (end < 0) return null
      const line = bytes.subarray(offset, end).toString('utf8')
      // Conversation records are skipped without parsing or retaining their payload.
      if (line.includes('"event_msg"')) {
        const record = JSON.parse(line) as { type?: string; payload?: { type?: string; turn_id?: string } }
        const event = record.type === 'event_msg' ? record.payload : undefined
        if (event?.type === 'task_started' && typeof event.turn_id === 'string') {
          latest = { id: event.turn_id, offset: at + offset, ended: false }
          positions.set(event.turn_id, at + offset)
        } else if (latest !== undefined && event?.turn_id === latest.id &&
            ['task_complete', 'turn_aborted'].includes(event.type ?? '')) {
          latest.ended = true
          latest.outcome = event.type === 'turn_aborted' ? 'aborted' : 'completed'
        }
      }
      if (includeQuestions && line.includes('"response_item"')) {
        const record = JSON.parse(line) as { type?: string; payload?: { type?: string; name?: string; call_id?: string; arguments?: string; output?: string } }
        const item = record.type === 'response_item' ? record.payload : undefined
        if (latest !== undefined && item?.type === 'function_call' && item.name === 'request_user_input_async') {
          if (latest.ended || typeof item.call_id !== 'string' || item.call_id.trim() === '' ||
              questionCalls.has(item.call_id) || typeof item.arguments !== 'string') return null
          questionCalls.add(item.call_id)
          const args = JSON.parse(item.arguments) as { questions?: Array<{ title?: unknown; options?: unknown }> }
          if (!Array.isArray(args.questions) || args.questions.length === 0) return null
          for (const [index, question] of args.questions.entries()) {
            if (question === null || typeof question.title !== 'string' ||
                (question.options !== undefined && (!Array.isArray(question.options) || !question.options.every(option => typeof option === 'string')))) return null
            questions.push({ offset: at + offset, turn_id: latest.id, call_id: item.call_id, index, title: question.title,
              ...(question.options === undefined ? {} : { options: question.options as string[] }), accepted: false })
          }
        } else if (item?.type === 'function_call_output' && typeof item.call_id === 'string' &&
            questions.some(question => question.call_id === item.call_id)) {
          // Missing, conflicting or repeated receipts cannot prove one emission.
          if (outputs.has(item.call_id) || typeof item.output !== 'string') return null
          const output = JSON.parse(item.output) as { accepted?: boolean }
          outputs.set(item.call_id, output?.accepted === true)
        }
      }
      offset = end + 1
    }
    const after = fstatSync(fd)
    const current = lstatSync(canonical)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || current.isSymbolicLink() ||
        current.dev !== stat.dev || current.ino !== stat.ino) return null
    if (latest === undefined || at + offset !== stat.size) return null
    return { file: canonical, identity: `${stat.dev}:${stat.ino}`, size: stat.size, latest, positions,
      ...(includeQuestions ? { questions: questions.map(question => ({ ...question, accepted: outputs.get(question.call_id) === true })) } : {}) }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
