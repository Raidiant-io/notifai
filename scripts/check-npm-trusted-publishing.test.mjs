import assert from 'node:assert/strict'
import test from 'node:test'
import { supportsTrustedPublishing, supportsTrustedDistTags } from './check-npm-trusted-publishing.mjs'

test('trusted publishing rejects npm releases below 11.5.1', () => {
  assert.equal(supportsTrustedPublishing('11.4.9'), false)
  assert.equal(supportsTrustedPublishing('11.5.0'), false)
})

test('trusted publishing accepts npm 11.5.1 and later releases', () => {
  assert.equal(supportsTrustedPublishing('11.5.1'), true)
  assert.equal(supportsTrustedPublishing('11.6.0'), true)
  assert.equal(supportsTrustedPublishing('12.0.0'), true)
})

test('trusted publishing rejects malformed npm versions', () => {
  assert.equal(supportsTrustedPublishing('11.5'), false)
  assert.equal(supportsTrustedPublishing('11.5.1-beta.0'), false)
  assert.equal(supportsTrustedPublishing('unknown'), false)
})

test('OIDC discovery promotion respects both supported npm release-line floors', () => {
  for (const version of ['11.20.9', '12.0.0', '12.1.9', 'unknown']) assert.equal(supportsTrustedDistTags(version), false)
  for (const version of ['11.21.0', '11.22.0', '12.2.0', '13.0.0']) assert.equal(supportsTrustedDistTags(version), true)
})
