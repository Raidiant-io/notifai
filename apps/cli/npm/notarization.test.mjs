import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyNotarization } from './notarization.mjs'

const missing = { status: 1, stderr: 'valid on disk\nsatisfies its Designated Requirement\ntest-requirement: code failed to satisfy specified code requirement(s)\n' }
const accepted = { status: 0, stderr: 'binary: accepted\nsource=Notarized Developer ID\n' }
function rig(results) {
  const calls = [], delays = [], reports = []
  const run = (command, args) => { calls.push({ command, args }); assert.ok(results.length); return results.shift() }
  return { calls, delays, reports, options: { run, pause: ms => delays.push(ms), report: item => reports.push(item) } }
}
test('the captured generic failure retries only after independent notarized acceptance', () => {
  const r = rig([missing, accepted, { status: 0, stderr: 'explicit requirement satisfied' }])
  assert.equal(verifyNotarization('/binary', r.options).attempts, 2)
  assert.deepEqual(r.delays, [5000])
  assert.equal(r.reports[0].classification, 'lookup-inconsistent')
  assert.equal(r.reports[0].codesign.stderr, missing.stderr)
  assert.equal(r.calls[1].command, '/usr/sbin/spctl')
})
test('real rejection and unknown failure never retry', () => {
  for (const result of [ { status: 3, stderr: 'binary: rejected\nsource=Unnotarized Developer ID' },
    { status: 0, stderr: 'accepted\nsource=Developer ID' }, { status: 1, stderr: 'unknown assessment error' } ]) {
    const r = rig([missing, result])
    assert.throws(() => verifyNotarization('/binary', r.options), /notarization verification failed/)
    assert.deepEqual(r.delays, [])
  }
})
test('explicit revocation wins over network diagnostics and never invokes a fallback', () => {
  const r = rig([{ status: 1, stderr: 'CSSMERR_TP_CERT_REVOKED\nNSURLErrorDomain Code=-1009' }])
  assert.throws(() => verifyNotarization('/binary', r.options), /notarization verification failed/)
  assert.equal(r.calls.length, 1)
  assert.deepEqual(r.delays, [])
})
test('explicit transport errors retry with bounded backoff and retain every failure', () => {
  const failure = { status: 1, stderr: 'NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline."' }
  const r = rig([failure, failure, failure])
  assert.throws(() => verifyNotarization('/binary', r.options), /notarization verification failed/)
  assert.deepEqual(r.delays, [5000, 15000])
  assert.equal(r.reports.length, 3)
  assert.ok(r.reports.every(item => item.classification === 'lookup-unavailable'))
})
test('a positive assessment never substitutes for the required codesign success', () => {
  const r = rig([missing, accepted, missing, accepted, missing, accepted])
  assert.throws(() => verifyNotarization('/binary', r.options), /notarization verification failed/)
  assert.deepEqual(r.delays, [5000, 15000])
})
test('timeout, bad signatures, and unclassified errors fail closed', () => {
  for (const result of [ { status: null, error: { code: 'ETIMEDOUT' }, stderr: '' },
    { status: 1, stderr: 'invalid signature (code or signature have been modified)' },
    { status: 1, stderr: 'unclassified failure' } ]) {
    const r = rig([result])
    assert.throws(() => verifyNotarization('/binary', r.options), /notarization verification failed/)
    assert.equal(r.calls.length, 1)
    assert.deepEqual(r.delays, [])
  }
})
