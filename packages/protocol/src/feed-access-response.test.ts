import { describe, expect, it } from 'vitest'
import { isAccountAccessResponse } from './api.js'
import { isCompanionChangesPage } from './changes.js'

const access = { status: 'active', reason: 'alpha_grant', expires_at: null, email: null, public_v1_cutover: false }
const row = {
  request_id: 'opaque/request', revision: 'opaque/revision', accepted_at: 'time', native_expires_at: 'time',
  retained_until: 'time', insertable: true, has_body: false, draft: { schema_version: 1, kind: 'done', presentation: { title: 'T', summary: 'S' }, targets: { mode: 'all' }, delivery: { ttl_seconds: 60, collapse_key: null }, future: true },
  project_name: null, delivery_id: null, reply_expires_at: null, retired_at: null, retirement: null,
  read_at: null, agent_acknowledgement_required: false, latest_reply: null, agent_acknowledgement: null,
}
const message = {
  message_id: 'm', session_id: 's', client_message_id: 'c', device_id: null, state: 'accepted',
  not_delivered_reason: null, agent_acknowledgement_text_required: false, agent_acknowledgement: null,
  created_at: 'time', handed_off_at: null, revision: 'revision', kind: 'note', body: '', request_id: null,
}
const page = { notifications: [row], session_messages: [message], presence: null, next_cursor: 'opaque / cursor', has_more: false }
function without(value: Record<string, unknown>, key: string) {
  const result = { ...value }
  delete result[key]
  return result
}

describe('canonical response boundaries', () => {
  it.each(Object.keys(access))('requires access %s', key => {
    expect(isAccountAccessResponse(without(access, key))).toBe(false)
  })
  it.each(['no_active_grant', 'alpha_grant', 'subscription', 'payment_exemption'])('preserves access reason %s', reason => {
    expect(isAccountAccessResponse({ ...access, reason, future: {} })).toBe(true)
  })
  it.each(Object.keys(page))('requires feed %s', key => {
    expect(isCompanionChangesPage(without(page, key))).toBe(false)
  })
  it.each(Object.keys(row))('requires notification row %s', key => {
    expect(isCompanionChangesPage({ ...page, notifications: [without(row, key)] })).toBe(false)
  })
  it.each(Object.keys(message))('requires message row %s', key => {
    expect(isCompanionChangesPage({ ...page, session_messages: [without(message, key)] })).toBe(false)
  })
  it.each([
    { state: 'running', activity: 'idle', accepts_messages: true, last_seen_at: 'time' },
    { state: 'out_of_reach', last_seen_at: 'time' },
    { state: 'out_of_reach', last_seen_at: 'time', accepts_messages: true },
    { state: 'ended', ended_at: 'time' }, { state: 'unknown' },
  ])('preserves presence %j', presence => {
    expect(isCompanionChangesPage({ ...page, presence: [{ session_id: 'opaque', presence, future: true }] })).toBe(true)
  })
  it.each([{}, { state: 'running' }, { state: 'ended' }, { state: 'out_of_reach' },
    { state: 'running', activity: 'invalid', accepts_messages: true, last_seen_at: 'time' },
  ])('rejects malformed presence %j', presence => {
    expect(isCompanionChangesPage({ ...page, presence: [{ session_id: 's', presence }] })).toBe(false)
  })
  it('preserves optional metadata, answer edits and additive fields', () => {
    expect(isCompanionChangesPage({ ...page, future: true,
      notifications: [{ ...row, dismissed_at: null, answer_versions: [], future: true }],
      session_messages: [{ ...message, kind: 'answer_edit', request_id: 'r', text: '', answers: [], not_delivered_reason: 'future_reason' }],
    })).toBe(true)
  })
  it.each([{ ...row, draft: null }, { ...row, latest_reply: [] }, { ...row, answer_versions: [null] },
    { ...row, dismissed_at: 1 }, { ...row, read_at: false }, { ...row, retirement: {} },
  ])('rejects malformed nested object boundaries %j', notification => {
    expect(isCompanionChangesPage({ ...page, notifications: [notification] })).toBe(false)
  })
  it('rejects missing nested response fields', () => {
    expect(isCompanionChangesPage({ ...page, notifications: [{ ...row, latest_reply: {}, answer_versions: [{}] }] })).toBe(false)
  })
})
