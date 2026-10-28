import { expect, it } from 'vitest'
import { isSubmitReplyResponse } from './api.js'
import { isCreateAnswerEditResponse, isCreateSessionNoteResponse } from './sessions.js'

const reply = { outcome: 'recorded', reply: { reply_id: 'opaque:reply', seq: 1.5, delivery_id: null,
  device_id: null, device_name: '', text: '', answers: [], source: 'future client', created_at: '' } }
const note = { replayed: false, message: { kind: 'note', message_id: '', session_id: '',
  client_message_id: '', device_id: null, state: 'accepted', not_delivered_reason: 'future reason',
  agent_acknowledgement_text_required: false, agent_acknowledgement: null, created_at: '',
  handed_off_at: null, revision: '', body: '', request_id: null } }
const edit = { replayed: false, answer_version: { origin: 'companion', provenance: null, base_version: null,
  version_id: '', source: 'edit', status: 'presented', not_delivered_reason: 'future reason',
  answers: [], text: '', device_id: null, created_at: '', agent_acknowledgement: null } }
const cases = [
  { name: 'reply', accepts: isSubmitReplyResponse, value: reply, replay: { ...reply, outcome: 'replayed' },
    bad: [{ ...reply, outcome: 'unknown' }, { ...reply, reply: null }, { ...reply, reply: { ...reply.reply, answers: [{}] } }] },
  { name: 'note', accepts: isCreateSessionNoteResponse, value: note, replay: { ...note, replayed: true },
    bad: [{ ...note, replayed: 'yes' }, { ...note, message: null }, { ...note, message: { ...note.message, kind: 'unknown' } }] },
  { name: 'Answer Edit', accepts: isCreateAnswerEditResponse, value: edit, replay: { ...edit, replayed: true },
    bad: [{ ...edit, replayed: 'yes' }, { ...edit, answer_version: null }, { ...edit, answer_version: { ...edit.answer_version, answers: [{}] } }] },
]

it.each(cases)('accepts new/replayed $name responses with additive and existing opaque facts', ({ accepts, value, replay }) => {
  for (const response of [value, replay]) {
    const body = { ...response, future: { supported: true } }
    const before = structuredClone(body)
    expect(accepts(body)).toBe(true)
    expect(body).toEqual(before)
  }
})

it.each(cases)('rejects unusable $name confirmations', ({ accepts, bad }) => {
  for (const response of [null, [], {}, ...bad]) expect(accepts(response), JSON.stringify(response)).toBe(false)
})
