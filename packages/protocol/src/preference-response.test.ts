import { Value } from '@sinclair/typebox/value'
import { expect, it } from 'vitest'
import { AccountPreferences, isAccountPreferencesResponse, UpdateAccountPreferencesRequest } from './api.js'

it.each([
  { agent_acknowledgement_text_enabled: false },
  { agent_acknowledgement_text_enabled: true, send_delay_seconds: 0 },
  { agent_acknowledgement_text_enabled: false, send_delay_seconds: 5, future: { supported: true } },
])('preserves existing and additive preference responses without filling absent values: %j', body => {
  const before = structuredClone(body)
  expect(isAccountPreferencesResponse(body)).toBe(true)
  expect(body).toEqual(before)
})

it.each([null, [], {}, { agent_acknowledgement_text_enabled: 'off' },
  { agent_acknowledgement_text_enabled: true, send_delay_seconds: '3' },
  { agent_acknowledgement_text_enabled: true, send_delay_seconds: -1 }])('rejects unusable preference facts %j', body => {
  expect(isAccountPreferencesResponse(body)).toBe(false)
})

it('keeps existing configuration and partial update requests closed', () => {
  const body = { agent_acknowledgement_text_enabled: false, future: true }
  expect(isAccountPreferencesResponse(body)).toBe(true)
  expect(Value.Check(AccountPreferences, body)).toBe(false)
  expect(Value.Check(UpdateAccountPreferencesRequest, body)).toBe(false)
  expect(Value.Check(UpdateAccountPreferencesRequest, { send_delay_seconds: 0 })).toBe(true)
})
