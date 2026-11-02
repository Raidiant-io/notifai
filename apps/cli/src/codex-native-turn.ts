/** Read typed lifecycle and optional question records from an owned native transcript. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { configHome } from './install-hooks.js'

export interface NativeTurnSnapshot {
  file: string
  identity: string
  size: number
  latest: { id: string; offset: number; ended: boolean; outcome?: 'completed' | 'aborted' }
  positions: Map<string, number>
  /** Only populated by explicit question observation, never by activity polling. */
  questions?: NativeQuestionEmission[]
}

export interface NativeInputSnapshot {
  file: string
  identity: string
  size: number
  /** First complete record read: confirmation must cover the hook's entire suffix. */
  tailStart: number
  userMessages: Array<{ offset: number; turn_id: string | null; hash: string }>
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

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

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

/** The latest turn in the owned, stable bounded tail, for a check made while that turn runs. */
export function readNativeTurnTail(file: unknown, sessionId: string, env: NodeJS.ProcessEnv): NativeTurnSnapshot | null {
  const observed = readNativeTranscript(file, sessionId, env, false)
  return observed !== null && 'latest' in observed ? observed : null
}

/** Observe actual native async-question calls plus their acceptance receipts.
 * User messages, quoted examples and injected app-answer envelopes are never
 * question emissions. This reads only the same owned, stable bounded tail.
 */
export function readNativeQuestionSnapshot(file: unknown, sessionId: string, env: NodeJS.ProcessEnv): NativeTurnSnapshot | null {
  const observed = readNativeTranscript(file, sessionId, env, false, true)
  return observed !== null && 'latest' in observed ? observed : null
}

/** Card input confirmation does not need a tool call or turn start still in
 * the tail. Its hook already owns those identities; it needs committed input. */
export function readNativeInputSnapshot(file: unknown, sessionId: string, env: NodeJS.ProcessEnv): NativeInputSnapshot | null {
  const observed = readNativeTranscript(file, sessionId, env, false, false, true)
  return observed !== null && 'userMessages' in observed ? observed : null
}

/** Ownership can be proved even when a long turn exceeds the activity bound. */
export function nativeTranscriptOwned(file: unknown, sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return readNativeTranscript(file, sessionId, env, true) !== null
}

/**
 * The model of the newest turn context in an owned transcript's bounded tail.
 * Codex writes one per turn, before the model runs, so during a turn this is
 * that turn's model. Anything unreadable, unowned or out of bound is unknown.
 */
export function readNativeTurnModel(file: unknown, sessionId: string, env: NodeJS.ProcessEnv): string | null {
  const owned = readNativeTranscript(file, sessionId, env, true)
  if (owned === null) return null
  let fd: number | undefined
  try {
    fd = openSync(owned.file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (`${stat.dev}:${stat.ino}` !== owned.identity) return null
    const at = Math.max(0, stat.size - TAIL_BYTES)
    const bytes = Buffer.alloc(stat.size - at)
    if (readSync(fd, bytes, 0, bytes.length, at) !== bytes.length) return null
    const lines = bytes.toString('utf8').split('\n')
    // A tail that starts mid-record cannot vouch for its first line.
    if (at > 0) lines.shift()
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!
      if (!line.includes('"turn_context"')) continue
      let record: { type?: unknown; payload?: { model?: unknown } }
      try { record = JSON.parse(line) as typeof record } catch { continue }
      if (record?.type !== 'turn_context') continue
      const model = record.payload?.model
      return typeof model === 'string' && model !== '' ? model : null
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readNativeTranscript(
  file: unknown, sessionId: string, env: NodeJS.ProcessEnv, identityOnly: boolean, includeQuestions = false,
  inputOnly = false,
): NativeInputSnapshot | NativeTurnSnapshot | Pick<NativeTurnSnapshot, 'file' | 'identity'> | null {
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
    const userMessages: NativeInputSnapshot['userMessages'] = []
    const tailStart = at + offset
    const questionCalls = new Set<string>()
    const outputs = new Map<string, boolean>()
    while (offset < limit) {
      const end = bytes.indexOf(10, offset)
      if (end < 0) return null
      const line = bytes.subarray(offset, end).toString('utf8')
      // Conversation records are skipped without parsing or retaining their payload.
      if (line.includes('"event_msg"')) {
        const record = JSON.parse(line) as { type?: string; payload?: { type?: string; turn_id?: string; message?: unknown } }
        const event = record.type === 'event_msg' ? record.payload : undefined
        if (inputOnly && event?.type === 'user_message' && typeof event.message === 'string') {
          userMessages.push({ offset: at + offset, turn_id: latest?.id ?? null, hash: digest(Buffer.from(event.message)) })
        }
        if (event?.type === 'task_started' && typeof event.turn_id === 'string') {
          latest = { id: event.turn_id, offset: at + offset, ended: false }
          positions.set(event.turn_id, at + offset)
        } else if (latest !== undefined && event?.turn_id === latest.id &&
            ['task_complete', 'turn_aborted'].includes(event.type ?? '')) {
          latest.ended = true
          latest.outcome = event.type === 'turn_aborted' ? 'aborted' : 'completed'
        }
      }
      if ((includeQuestions || inputOnly) && line.includes('"response_item"')) {
        const record = JSON.parse(line) as { type?: string; payload?: { type?: string; name?: string; call_id?: string; arguments?: string; output?: string; role?: string; content?: Array<{ type?: string; text?: string }> } }
        const item = record.type === 'response_item' ? record.payload : undefined
        if (inputOnly && item?.type === 'message' && item.role === 'user' && Array.isArray(item.content) &&
            item.content.length > 0 && item.content.every(part => part.type === 'input_text' && typeof part.text === 'string')) {
          userMessages.push({ offset: at + offset, turn_id: latest?.id ?? null,
            hash: digest(Buffer.from(item.content.map(part => part.text).join(''))) })
        }
        if (includeQuestions && latest !== undefined && item?.type === 'function_call' && item.name === 'request_user_input_async') {
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
        } else if (includeQuestions && item?.type === 'function_call_output' && typeof item.call_id === 'string' &&
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
    if (at + offset !== stat.size) return null
    if (inputOnly) return { file: canonical, identity, size: stat.size, tailStart, userMessages }
    if (latest === undefined) return null
    return { file: canonical, identity: `${stat.dev}:${stat.ino}`, size: stat.size, latest, positions,
      ...(includeQuestions ? { questions: questions.map(question => ({ ...question, accepted: outputs.get(question.call_id) === true })) } : {}) }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
