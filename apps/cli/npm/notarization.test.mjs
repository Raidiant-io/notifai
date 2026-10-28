import assert from 'node:assert/strict'
import test from 'node:test'
import { TICKET_SERVICE, verifyNotarization } from './notarization.mjs'

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
  for (const result of [ { status: 3, stderr: 'binary: rejected\nsource=Developer ID' },
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
  const r = rig([failure, failure, failure, failure])
  assert.throws(() => verifyNotarization('/binary', r.options), /notarization verification failed/)
  assert.deepEqual(r.delays, [5000, 15000, 40000])
  assert.equal(r.reports.length, 4)
  assert.ok(r.reports.every(item => item.classification === 'lookup-unavailable'))
})
test('a positive assessment never substitutes for the required codesign success', () => {
  const r = rig([missing, accepted, missing, accepted, missing, accepted, missing, accepted])
  assert.throws(() => verifyNotarization('/binary', r.options), /notarization verification failed/)
  assert.deepEqual(r.delays, [5000, 15000, 40000])
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

// The captured runner failure: a valid Developer ID signature that this Mac's
// Gatekeeper reports as unnotarized, from release runs 40667109016 and others.
const unnotarized = { status: 3, stderr: '/tmp/notifai: rejected\nsource=Unnotarized Developer ID\norigin=Developer ID Application: Example (ABCDE12345)\n' }
const cdhash = '71bc74ee5b4bf535e889e535e59f08df332f4dc19b1e134469f7f344ec82498d'
const record = `2/2/${cdhash.slice(0, 40)}`
const display = { status: 0, stderr: `Executable=/tmp/notifai\nHash type=sha256 size=32\nCandidateCDHash sha256=${cdhash.slice(0, 40)}\nCandidateCDHashFull sha256=${cdhash}\nCDHash=${cdhash.slice(0, 40)}\n` }
const store = (body, http = '200') => ({ status: 0, stdout: `${JSON.stringify(body)}\n${http}` })
const held = store({ records: [{ recordName: record, recordType: 'DeveloperIDTicket', fields: { signedTicket: { value: 'czhjaAEAAAD' } } }] })
const absent = store({ records: [{ recordName: record, reason: 'Record not found', serverErrorCode: 'NOT_FOUND' }] })
const satisfied = { status: 0, stderr: 'explicit requirement satisfied' }

test('an unnotarized verdict for bytes Apple holds a ticket for retries until the local lookup admits them', () => {
  const r = rig([missing, unnotarized, display, held, missing, unnotarized, display, held, satisfied])
  const result = verifyNotarization('/binary', r.options)
  assert.equal(result.attempts, 3)
  assert.deepEqual(r.delays, [5000, 15000])
  assert.ok(r.reports.every(item => item.classification === 'lookup-inconsistent' && item.ticket.answer === 'held'))
  const curl = r.calls.find(call => call.command === '/usr/bin/curl')
  assert.ok(curl.args.includes(TICKET_SERVICE) && curl.args.includes('=https'))
  assert.equal(curl.args[0], '-q', 'a user curlrc must never apply')
  assert.equal(JSON.parse(curl.args[curl.args.indexOf('--data') + 1]).records[0].recordName, record)
})
test('Apple holding a ticket never substitutes for the required local codesign success', () => {
  const r = rig(Array.from({ length: 4 }, () => [missing, unnotarized, display, held]).flat())
  assert.throws(() => verifyNotarization('/binary', r.options), /lookup-inconsistent, attempt 4/)
  assert.deepEqual(r.delays, [5000, 15000, 40000])
})
test('bytes Apple holds no ticket for fail at once as not notarized', () => {
  const r = rig([missing, unnotarized, display, absent])
  assert.throws(() => verifyNotarization('/binary', r.options), /not-notarized, attempt 1/)
  assert.deepEqual(r.delays, [])
})
test('an unreachable ticket store is a bounded transport retry', () => {
  const down = { status: 6, stdout: '\n000', stderr: 'curl: (6) Could not resolve host' }
  const r = rig(Array.from({ length: 4 }, () => [missing, unnotarized, display, down]).flat())
  assert.throws(() => verifyNotarization('/binary', r.options), /lookup-unavailable, attempt 4/)
  assert.deepEqual(r.delays, [5000, 15000, 40000])
  assert.equal(r.reports[0].ticket.answer, 'unavailable')
})
test('ticket store answers that do not name this exact code are not a held ticket', () => {
  for (const reply of [store({ records: [{ recordName: '2/2/0000000000000000000000000000000000000000', recordType: 'DeveloperIDTicket', fields: { signedTicket: { value: 'x' } } }] }),
    store({ records: [{ recordName: record, serverErrorCode: 'THROTTLED' }] }), store({ records: [] }, '503'),
    { status: 0, stdout: 'not json\n200' }]) {
    const r = rig([missing, unnotarized, display, reply, satisfied])
    verifyNotarization('/binary', r.options)
    assert.equal(r.reports[0].classification, 'lookup-unavailable')
  }
})
test('the ticket store is consulted only for an intact Developer ID signature', () => {
  for (const [codesign, assessment] of [
    [{ status: 3, stderr: 'valid on disk\ntest-requirement: code failed to satisfy specified code requirement(s)\n' }, unnotarized],
    [missing, { status: 3, stderr: '/tmp/notifai: rejected\nsource=Unnotarized Developer ID\nCSSMERR_TP_CERT_REVOKED\n' }],
    [missing, { status: 3, stderr: '/tmp/notifai: rejected\nsource=No Matching Rule\n' }],
  ]) {
    const r = rig([codesign, assessment])
    assert.throws(() => verifyNotarization('/binary', r.options), /rejected-or-unknown, attempt 1/)
    assert.ok(!r.calls.some(call => call.command === '/usr/bin/curl'))
  }
})
test('code without a SHA-256 code directory hash cannot be looked up and fails closed', () => {
  const r = rig([missing, unnotarized, { status: 0, stderr: 'Hash type=sha1 size=20\nCDHash=abc\n' }])
  assert.throws(() => verifyNotarization('/binary', r.options), /rejected-or-unknown, attempt 1/)
  assert.ok(!r.calls.some(call => call.command === '/usr/bin/curl'))
})
