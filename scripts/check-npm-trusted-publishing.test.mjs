import assert from 'node:assert/strict'
import test from 'node:test'
import { supportsTrustedPublishing } from './check-npm-trusted-publishing.mjs'

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
