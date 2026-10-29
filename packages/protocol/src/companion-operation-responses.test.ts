import { describe, expect, it } from 'vitest'
import { isBeginPairingResponse, isPairingDetailsResponse, isApprovePairingResponse, isDismissQuestionResponse } from './api.js'
import { isCompanionReadsResponse } from './changes.js'
import { isAgentSessionView, isListAgentSessionsResponse } from './sessions.js'

const label = { session_id: 'opaque session', label: 'Name', renamed_by: 'agent', updated_at: 'opaque time' }
const pairing = { pairing_id: 'opaque pairing', machine_name: 'Machine', code: 'code', status: 'pending', expires_at: 'opaque time' }

it('keeps older session labels and additive presence/harness facts compatible', () => {
  expect(isAgentSessionView({ ...label, future: true })).toBe(true)
  expect(isListAgentSessionsResponse({ agent_sessions: [label], future: true })).toBe(true)
  for (const presence of [
    { state: 'unknown' }, { state: 'ended', ended_at: 'opaque' },
    { state: 'out_of_reach', last_seen_at: 'opaque' },
    { state: 'out_of_reach', last_seen_at: 'opaque', accepts_messages: true },
    { state: 'running', activity: 'idle', accepts_messages: false, last_seen_at: 'opaque' },
  ]) {
    expect(isListAgentSessionsResponse({ agent_sessions: [{ ...label, harness: 'future harness', presence: { ...presence, future: true } }] })).toBe(true)
  }
})

it.each([
  { ...label, session_id: null }, { ...label, label: false }, { ...label, renamed_by: 'future' },
  { ...label, updated_at: undefined }, { ...label, harness: null },
])('rejects unusable label rows %j', (row) => {
  expect(isAgentSessionView(row)).toBe(false)
  expect(isListAgentSessionsResponse({ agent_sessions: [row] })).toBe(false)
})

it.each([null, { state: 'running' }, { state: 'out_of_reach', last_seen_at: 'time', accepts_messages: false }])(
  'rejects malformed present Session Presence %j', (presence) => {
    expect(isListAgentSessionsResponse({ agent_sessions: [{ ...label, presence }] })).toBe(false)
  },
)

describe('pairing and question operations', () => {
  it('retains every settled pairing state and opaque service facts', () => {
    for (const status of ['pending', 'approved', 'denied', 'expired', 'stopped']) {
      expect(isPairingDetailsResponse({ ...pairing, status, future: true })).toBe(true)
    }
    expect(isBeginPairingResponse({ pairing_id: 'id', code: 'code', approve_url: 'opaque', expires_at: 'opaque', poll_interval_seconds: 1.5, future: true })).toBe(true)
    expect(isApprovePairingResponse({ machine_id: 'opaque/machine', future: true })).toBe(true)
    expect(isDismissQuestionResponse({ request_id: 'id', dismissed_at: null, future: true })).toBe(true)
    expect(isDismissQuestionResponse({ request_id: 'id', dismissed_at: 'opaque' })).toBe(true)
    expect(isCompanionReadsResponse({ marked: 0, future: true })).toBe(true)
  })
  it('rejects fields whose wrong types would turn a failed operation into success', () => {
    expect(isPairingDetailsResponse({ ...pairing, status: 'future' })).toBe(false)
    expect(isPairingDetailsResponse({ ...pairing, expires_at: null })).toBe(false)
    expect(isBeginPairingResponse({ pairing_id: 'id', code: 'code', approve_url: 'opaque', expires_at: 'opaque', poll_interval_seconds: '1' })).toBe(false)
    expect(isApprovePairingResponse({ machine_id: '' })).toBe(false)
    expect(isDismissQuestionResponse({ request_id: 'id' })).toBe(false)
    expect(isCompanionReadsResponse({ marked: '0' })).toBe(false)
  })
})
