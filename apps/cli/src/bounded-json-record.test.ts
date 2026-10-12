import { expect, it } from 'vitest'
import { newJsonRecord, traverseJsonByte, validJsonRecord } from './bounded-json-record.js'

function validate(text: string) {
  let state = newJsonRecord()
  let completed = false
  // Serialize at every byte to exercise actual persisted chunk boundaries,
  // including escapes, UTF-8 continuations, numbers and container delimiters.
  for (const byte of Buffer.from(text)) {
    state = JSON.parse(JSON.stringify(state)) as typeof state
    expect(validJsonRecord(state)).toBe(true)
    completed = traverseJsonByte(state, byte)
  }
  return { state, completed }
}

it.each([
  '{}\n', '{"a":[true,false,null,-0,0.1,1e-3,2E+4,{},[]]}\r\n',
  '{"\\u0074ype":"event_msg","payload":{"text":"☀️ 😀 \\" \\\\ \\n \\u1234"}}\n',
  '{"payload":{"type":"task_started","turn_id":"quoted"},"type":"response_item"}\n',
])('validates complete JSON framing across every possible byte boundary: %j', text => {
  const parsed = JSON.parse(text) as { type?: string }
  const result = validate(text)
  expect(result).toMatchObject({ completed: true, state: { done: true } })
  expect(result.state.type).toBe(parsed.type)
})

it.each([
  '{"x":01}\n', '{"x":1.}\n', '{"x":1e+}\n', '{"x":+1}\n', '{"x":tru}\n',
  '{"x":false true}\n', '{"x":[1,]}\n', '{"x":1,}\n', '{"x":"\\q"}\n',
  '{"x":"\\u00xz"}\n', '{"x":"unescaped\nnewline"}\n', '{}{}\n', '[]\n',
  '{"type":"response_item","\\u0074ype":"event_msg"}\n',
  '{"payload":{},"\\u0070ayload":{}}\n',
  '{"type":"event_msg","payload":{"type":"agent_message","\\u0074ype":"task_complete"}}\n',
  '{"type":"event_msg","payload":{"turn_id":"a","turn_id":"b"}}\n',
])('rejects invalid or ambiguous records: %j', text => {
  expect(() => validate(text)).toThrow('invalid-json-record')
})

it('requires the newline and bounds depth plus retained key/type tokens', () => {
  expect(validate('{"type":"response_item"}').completed).toBe(false)
  expect(() => validate(`{"x":${'['.repeat(64)}0${']'.repeat(64)}}\n`)).toThrow('invalid-json-record')
  const state = newJsonRecord()
  for (const byte of Buffer.from(`{"${'x'.repeat(10_000)}`)) traverseJsonByte(state, byte)
  expect(JSON.stringify(state).length).toBeLessThan(1000)
})

it.each([[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x22]])(
  'rejects malformed UTF-8 in strings: %j', (...bytes) => {
    const state = newJsonRecord()
    expect(() => {
      for (const byte of Buffer.concat([Buffer.from('{"x":"'), Buffer.from(bytes), Buffer.from('"}\n')])) traverseJsonByte(state, byte)
    }).toThrow('invalid-json-record')
  },
)
