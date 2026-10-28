import { Value } from '@sinclair/typebox/value'
import { expect, it } from 'vitest'
import { isAccountSoundDefaultsResponse, isListSoundsResponse, isSoundView, UpdateAccountSoundDefaultsRequest } from './api.js'

const sound = { sound_id: 'opaque/sound', name: '', duration_ms: 1.5, content_hash: 'opaque:hash', url: '/signed/sound?signature=keep' }

it('preserves sound facts, empty lists and additive response fields without changing them', () => {
  const value = { ...sound, future: { supported: true } }
  const before = structuredClone(value)
  expect(isSoundView(value)).toBe(true)
  expect(isListSoundsResponse({ sounds: [], future: true })).toBe(true)
  expect(isListSoundsResponse({ sounds: [value], future: true })).toBe(true)
  expect(value).toEqual(before)
})

it.each(Object.keys(sound))('requires the %s sound fact', key => {
  const value = Object.fromEntries(Object.entries(sound).filter(([field]) => field !== key))
  expect(isSoundView(value)).toBe(false)
  expect(isListSoundsResponse({ sounds: [value] })).toBe(false)
})

it.each([{ sound_id: 1 }, { name: null }, { duration_ms: '100' }, { content_hash: false }, { url: null }])('rejects unusable sound facts %j', fields => {
  expect(isSoundView({ ...sound, ...fields })).toBe(false)
})

it.each([null, [], {}, { sounds: '' }, { sounds: null }, { sounds: [null] }])('rejects malformed library responses %j', body => {
  expect(isListSoundsResponse(body)).toBe(false)
})

it('preserves sparse and additive default responses while update requests remain closed', () => {
  const sounds = { update: 'done', question: 'opaque:sound', future: { supported: true } }
  const value = { sounds, future: true }
  const before = structuredClone(value)
  expect(isAccountSoundDefaultsResponse({ sounds: {} })).toBe(true)
  expect(isAccountSoundDefaultsResponse(value)).toBe(true)
  expect(value).toEqual(before)
  expect(Value.Check(UpdateAccountSoundDefaultsRequest, value)).toBe(false)
  expect(Value.Check(UpdateAccountSoundDefaultsRequest, { sounds })).toBe(false)
  expect(Value.Check(UpdateAccountSoundDefaultsRequest, { sounds: { update: 'done' } })).toBe(true)
})

it.each([null, [], {}, { sounds: null }, { sounds: '' }, { sounds: [] }, { sounds: { update: false } },
  { sounds: { question: 1 } }, { sounds: { done: '' } }])('rejects malformed Account defaults %j', value => {
  expect(isAccountSoundDefaultsResponse(value)).toBe(false)
})
