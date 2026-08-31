import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityUrl, verifyLiveServerContract } from './check-live-server-contract.mjs'

test('checks the public production capability document over HTTPS', async () => {
  let requested
  await verifyLiveServerContract({
    expectedFingerprint: 'notification-draft/current',
    origin: 'https://api.example.test/',
    fetchImpl: async (input, init) => {
      requested = { input: String(input), init }
      return Response.json({ notification_contract_fingerprint: 'notification-draft/current' })
    },
  })

  assert.equal(requested.input, 'https://api.example.test/api/v1/capabilities/ios')
  assert.equal(requested.init.redirect, 'error')
})

test('refuses a release whose schema has not reached the deployed service', async () => {
  await assert.rejects(
    verifyLiveServerContract({
      expectedFingerprint: 'notification-draft/new',
      origin: 'https://api.example.test',
      fetchImpl: async () => Response.json({ notification_contract_fingerprint: 'notification-draft/old' }),
    }),
    /Deploy the matching service first; no package was published/,
  )
})

test('fails closed when the service cannot advertise a contract', async () => {
  await assert.rejects(
    verifyLiveServerContract({
      expectedFingerprint: 'notification-draft/current',
      origin: 'https://api.example.test',
      fetchImpl: async () => new Response('', { status: 503 }),
    }),
    /could not read the deployed service contract \(HTTP 503\)/,
  )
  assert.throws(() => capabilityUrl('http://api.example.test'), /HTTPS service origin/)
})
