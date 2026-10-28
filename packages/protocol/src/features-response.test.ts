import { expect, it } from 'vitest'
import { isFeaturesResponse, SERVER_FEATURES } from './sessions.js'

it.each([
  { features: [] },
  { features: [...SERVER_FEATURES] },
  { features: ['session_notes', 'future_feature', 'session_notes'], future: { enabled: true } },
])('accepts current and additive feature discovery without changing the response: %j', body => {
  const before = structuredClone(body)
  expect(isFeaturesResponse(body)).toBe(true)
  expect(body).toEqual(before)
})

it.each([null, [], {}, { features: null }, { features: 'session_notes' },
  { features: {} }, { features: ['session_notes', 7] }, { features: [false] }])(
  'rejects unusable feature discovery: %j', body => {
    expect(isFeaturesResponse(body)).toBe(false)
  },
)
