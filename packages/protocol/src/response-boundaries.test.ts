import { describe, expect, it } from 'vitest'
import { isCreateMediaUploadResponse, isRegisterInstallationResponse } from './api.js'

const identity = { device_id: 'opaque/device', recovery_installation_id: 'opaque recovery' }
const support = {
  state: 'current', reason: 'current', affected_operation: null, recovery_action: null,
  current_version: null, current_build: null, recommended_version: null, recommended_build: null,
  minimum_version: null, minimum_build: null, deprecation: null, sunset: null,
}
const grant = {
  media_id: 'opaque/media', upload_url: 'https://storage.example.test/upload?signature=opaque',
  upload_headers: { 'content-type': 'image/png', 'x-signature': 'opaque' }, expires_at: '2030-01-01T00:00:00.000Z',
}

describe('registration response', () => {
  it.each([identity, { ...identity, extra: true }, { ...identity, support: { ...support, extra: true } }])(
    'accepts legacy and additive responses %j', (value) => expect(isRegisterInstallationResponse(value)).toBe(true),
  )
  it.each([null, [], {}, { ...identity, device_id: 1 }, { ...identity, device_id: '' },
    { ...identity, recovery_installation_id: ' ' }, { ...identity, support: {} },
    { ...identity, support: { ...support, state: 'unknown' } }])(
    'rejects malformed fields %j', (value) => expect(isRegisterInstallationResponse(value)).toBe(false),
  )
})

describe('shared media upload grant', () => {
  it.each([grant, { ...grant, extra: true }, { ...grant, upload_url: 'http://localhost:54321/upload' },
    { ...grant, upload_headers: {}, expires_at: '2030-01-01T01:00:00+01:00' }])(
    'preserves signed, local and additive grant values %j', (value) => {
      const before = structuredClone(value)
      expect(isCreateMediaUploadResponse(value)).toBe(true)
      expect(value).toEqual(before)
    },
  )
  it.each([null, [], {}, { ...grant, media_id: ' ' }, { ...grant, upload_url: 'https://' },
    { ...grant, upload_url: 'file:///tmp/object' }, { ...grant, upload_url: 'https://user:pass@example.test/upload' }, { ...grant, upload_headers: [] },
    { ...grant, upload_headers: { key: 1 } }, { ...grant, upload_headers: { 'bad header': 'signed' } },
    { ...grant, upload_headers: { key: 'bad\nvalue' } }, { ...grant, expires_at: undefined },
    { ...grant, expires_at: 'invalid' }, { ...grant, expires_at: '2030-99-99T00:00:00Z' }])(
    'rejects unusable grant fields %j', (value) => expect(isCreateMediaUploadResponse(value)).toBe(false),
  )
})
