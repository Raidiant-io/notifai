import { expect, it } from 'vitest'
import { isPutRegistrationResponse, isResourceMutationResponse } from './api.js'

it('preserves numeric registration versions and additive response facts', () => {
  const body = { registration_version: 1.5, future: { supported: true } }
  const before = structuredClone(body)
  expect(isPutRegistrationResponse(body)).toBe(true)
  expect(body).toEqual(before)
  expect(isResourceMutationResponse({ ok: true, future: true })).toBe(true)
})

it.each([null, [], {}, { registration_version: null }, { registration_version: '1' }])(
  'rejects unconfirmed registration versions %j', value => {
    expect(isPutRegistrationResponse(value)).toBe(false)
  },
)

it.each([null, [], {}, { ok: false }, { ok: 'true' }])('requires confirmed health success %j', value => {
  expect(isResourceMutationResponse(value)).toBe(false)
})
