/** JSONL syntax traversal: no payload retention, bounded depth and token capture.
 * State is serializable so a read budget can end anywhere inside a record.
 */
type Expect = 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd'
type Frame = { kind: 'object' | 'array'; expect: Expect; key?: 'type' | 'payload' | 'turn_id' | 'other'; payload?: boolean }
export interface JsonRecordState {
  stack: Frame[]
  done: boolean
  token: 'none' | 'string' | 'number' | 'literal'
  role: 'key' | 'type' | 'payloadType' | 'ignore'
  raw: string
  overflow: boolean
  escape: boolean
  unicode: number
  utf8: number
  utf8Min: number
  utf8Max: number
  number: string
  literal: string
  literalAt: number
  seenType: boolean
  seenPayload: boolean
  seenPayloadType: boolean
  seenPayloadTurnId: boolean
  type?: string
  payloadType?: string
}

export function newJsonRecord(): JsonRecordState {
  return { stack: [], done: false, token: 'none', role: 'ignore', raw: '', overflow: false,
    escape: false, unicode: 0, utf8: 0, utf8Min: 128, utf8Max: 191,
    number: '', literal: '', literalAt: 0, seenType: false, seenPayload: false,
    seenPayloadType: false, seenPayloadTurnId: false }
}

/** Check persisted continuation shape before using it as parser state. */
export function validJsonRecord(value: unknown): value is JsonRecordState {
  if (value === null || typeof value !== 'object') return false
  const s = value as JsonRecordState
  if (!Array.isArray(s.stack) || s.stack.length > 64) return false
  const parent = s.stack.at(-1)
  return (s.stack.length === 0 || s.stack[0]?.kind === 'object') && s.stack.every(f => f !== null &&
    ['object', 'array'].includes(f.kind) && ['keyOrEnd', 'key', 'colon', 'valueOrEnd', 'value', 'commaOrEnd'].includes(f.expect) &&
    (f.kind === 'object' ? f.expect !== 'valueOrEnd' : ['valueOrEnd', 'value', 'commaOrEnd'].includes(f.expect)) &&
    (f.key === undefined || ['type', 'payload', 'turn_id', 'other'].includes(f.key)) &&
    (f.payload === undefined || (f.payload === true && f === s.stack[1] && f.kind === 'object' && s.stack[0]?.key === 'payload'))) &&
    typeof s.done === 'boolean' && ['none', 'string', 'number', 'literal'].includes(s.token) &&
    ['key', 'type', 'payloadType', 'ignore'].includes(s.role) && typeof s.raw === 'string' && s.raw.length <= 256 &&
    typeof s.overflow === 'boolean' && typeof s.escape === 'boolean' &&
    Number.isInteger(s.unicode) && s.unicode >= 0 && s.unicode <= 4 &&
    Number.isInteger(s.utf8) && s.utf8 >= 0 && s.utf8 <= 3 &&
    Number.isInteger(s.utf8Min) && s.utf8Min >= 128 && s.utf8Min <= 191 &&
    Number.isInteger(s.utf8Max) && s.utf8Max >= s.utf8Min && s.utf8Max <= 191 &&
    ['', 'minus', 'zero', 'int', 'dot', 'frac', 'e', 'esign', 'exp'].includes(s.number) &&
    ['', 'true', 'false', 'null'].includes(s.literal) && Number.isInteger(s.literalAt) &&
    s.literalAt >= 0 && s.literalAt <= s.literal.length &&
    typeof s.seenType === 'boolean' && typeof s.seenPayload === 'boolean' &&
    typeof s.seenPayloadType === 'boolean' && typeof s.seenPayloadTurnId === 'boolean' &&
    (s.type === undefined || (typeof s.type === 'string' && s.type.length <= 256 && s.seenType)) &&
    (s.payloadType === undefined || (typeof s.payloadType === 'string' && s.payloadType.length <= 256 && s.seenPayloadType)) &&
    (!s.done || (s.stack.length === 0 && s.token === 'none')) &&
    (s.token !== 'literal' || (s.literal !== '' && s.literalAt > 0 && s.literalAt < s.literal.length)) &&
    (s.token !== 'number' || s.number !== '') &&
    (s.token !== 'string' || (parent !== undefined && (s.role === 'key'
      ? parent.kind === 'object' && ['keyOrEnd', 'key'].includes(parent.expect)
      : ['value', 'valueOrEnd'].includes(parent.expect)))) &&
    (s.token === 'string' || (!s.escape && s.unicode === 0 && s.utf8 === 0))
}

const invalid = (): never => { throw new Error('invalid-json-record') }
function finishValue(s: JsonRecordState): void {
  const parent = s.stack.at(-1)
  if (parent === undefined) s.done = true
  else parent.expect = 'commaOrEnd'
}

/** Returns true only on the terminating newline of a complete root object. */
export function traverseJsonByte(s: JsonRecordState, c: number): boolean {
  if (s.token === 'string') {
    if (s.role !== 'ignore' && !s.overflow) {
      if (s.raw.length < 256) s.raw += String.fromCharCode(c)
      else { s.raw = ''; s.overflow = true }
    }
    if (s.utf8 > 0) {
      if (c < s.utf8Min || c > s.utf8Max) invalid()
      s.utf8--; s.utf8Min = 128; s.utf8Max = 191
    } else if (s.unicode > 0) {
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) invalid()
      s.unicode--
    } else if (s.escape) {
      s.escape = false
      if (c === 117) s.unicode = 4
      else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(c)) invalid()
    } else if (c === 92) s.escape = true
    else if (c === 34) {
      const value = s.overflow || s.role === 'ignore' ? undefined :
        JSON.parse(Buffer.from(`"${s.raw}`, 'latin1').toString('utf8')) as string
      const frame = s.stack.at(-1)
      if (s.role === 'key') {
        if (frame === undefined || frame.kind !== 'object') invalid()
        frame!.key = value === 'type' || value === 'payload' || value === 'turn_id' ? value : 'other'
        if (s.stack.length === 1 && frame!.key === 'type') {
          if (s.seenType) invalid()
          s.seenType = true
        }
        if (s.stack.length === 1 && frame!.key === 'payload') {
          if (s.seenPayload) invalid()
          s.seenPayload = true
        }
        if (frame!.payload && frame!.key === 'type') {
          if (s.seenPayloadType) invalid()
          s.seenPayloadType = true
        }
        if (frame!.payload && frame!.key === 'turn_id') {
          if (s.seenPayloadTurnId) invalid()
          s.seenPayloadTurnId = true
        }
        frame!.expect = 'colon'
      } else {
        if (s.role === 'type' && value !== undefined) s.type = value
        if (s.role === 'payloadType' && value !== undefined) s.payloadType = value
        finishValue(s)
      }
      s.token = 'none'; s.raw = ''; s.overflow = false
    } else if (c < 32) invalid()
    else if (c >= 128) {
      if (c >= 194 && c <= 223) s.utf8 = 1
      else if (c >= 224 && c <= 239) {
        s.utf8 = 2
        if (c === 224) s.utf8Min = 160
        if (c === 237) s.utf8Max = 159
      } else if (c >= 240 && c <= 244) {
        s.utf8 = 3
        if (c === 240) s.utf8Min = 144
        if (c === 244) s.utf8Max = 143
      } else invalid()
    }
    return false
  }
  if (s.token === 'literal') {
    if (c !== s.literal.charCodeAt(s.literalAt++)) invalid()
    if (s.literalAt === s.literal.length) { s.token = 'none'; finishValue(s) }
    return false
  }
  if (s.token === 'number') {
    const digit = c >= 48 && c <= 57
    const nonzero = c >= 49 && c <= 57
    const n = s.number
    if (n === 'minus' && (c === 48 || nonzero)) s.number = c === 48 ? 'zero' : 'int'
    else if ((n === 'int' || n === 'frac' || n === 'exp') && digit) { /* same state */ }
    else if ((n === 'zero' || n === 'int') && c === 46) s.number = 'dot'
    else if (n === 'dot' && digit) s.number = 'frac'
    else if (['zero', 'int', 'frac'].includes(n) && (c === 69 || c === 101)) s.number = 'e'
    else if (n === 'e' && (c === 43 || c === 45)) s.number = 'esign'
    else if ((n === 'e' || n === 'esign') && digit) s.number = 'exp'
    else {
      if (!['zero', 'int', 'frac', 'exp'].includes(n)) invalid()
      s.token = 'none'; finishValue(s)
      return traverseJsonByte(s, c)
    }
    return false
  }
  if (c === 10) { if (!s.done) invalid(); return true }
  if (c === 32 || c === 9 || c === 13) return false
  if (s.done) invalid()
  const frame = s.stack.at(-1)
  if (frame?.expect === 'colon') {
    if (c !== 58) invalid()
    frame.expect = 'value'; return false
  }
  if (frame?.expect === 'commaOrEnd') {
    if (c === 44) { frame.expect = frame.kind === 'object' ? 'key' : 'value'; return false }
    if (c !== (frame.kind === 'object' ? 125 : 93)) invalid()
    s.stack.pop(); finishValue(s); return false
  }
  if (frame?.kind === 'object' && (frame.expect === 'keyOrEnd' || frame.expect === 'key')) {
    if (c === 125 && frame.expect === 'keyOrEnd') { s.stack.pop(); finishValue(s); return false }
    if (c !== 34) invalid()
    s.token = 'string'; s.role = 'key'
    return false
  }
  if (frame?.kind === 'array' && frame.expect === 'valueOrEnd' && c === 93) {
    s.stack.pop(); finishValue(s); return false
  }
  if (frame === undefined && c !== 123) invalid()
  if (c === 123 || c === 91) {
    if (s.stack.length >= 64) invalid()
    s.stack.push({ kind: c === 123 ? 'object' : 'array', expect: c === 123 ? 'keyOrEnd' : 'valueOrEnd',
      ...(c === 123 && s.stack.length === 1 && frame?.key === 'payload' ? { payload: true } : {}) })
  } else if (c === 34) {
    s.token = 'string'; s.role = frame?.key === 'type'
      ? s.stack.length === 1 ? 'type' : frame.payload ? 'payloadType' : 'ignore'
      : 'ignore'
  } else if (c === 45 || (c >= 48 && c <= 57)) {
    s.token = 'number'; s.number = c === 45 ? 'minus' : c === 48 ? 'zero' : 'int'
  } else if (c === 116 || c === 102 || c === 110) {
    s.token = 'literal'; s.literal = c === 116 ? 'true' : c === 102 ? 'false' : 'null'; s.literalAt = 1
  } else invalid()
  return false
}
