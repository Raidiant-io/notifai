import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { verifyAcceptedNotarization } from './verify-accepted-notarization.mjs'

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notary-accepted-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'binary'); writeFileSync(file, 'accepted bytes')
  return { file, hash: createHash('sha256').update('accepted bytes').digest('hex') }
}
function missing() {
  return Object.assign(new Error('ticket missing'), {
    code: 'NOTARIZATION_VERIFICATION_FAILED', attempts: [{
      codesign: { status: 3, stdout: '', stderr: 'valid on disk\nsatisfies its Designated Requirement\ntest-requirement: code failed to satisfy specified code requirement(s)\n' },
      assessment: { status: 3, stdout: '', stderr: 'binary: rejected\nsource=Unnotarized Developer ID\n' },
    }],
  })
}
test('accepted bytes retry the captured missing-ticket response and still require success', t => {
  const f = fixture(t), delays = [], reports = []; let calls = 0
  const receipt = { attempts: 1 }
  assert.equal(verifyAcceptedNotarization(f.file, f.hash, {
    verify: () => { if (++calls < 3) throw missing(); return receipt },
    wait: ms => delays.push(ms), report: entry => reports.push(entry),
  }), receipt)
  assert.deepEqual(delays, [60_000, 180_000]); assert.equal(reports.length, 2)
  assert.equal(reports[0].assessment.stderr, missing().attempts[0].assessment.stderr)
})
test('persistent missing tickets fail after bounded retries', t => {
  const f = fixture(t); let calls = 0
  assert.throws(() => verifyAcceptedNotarization(f.file, f.hash, {
    verify: () => { calls++; throw missing() }, wait: () => {}, report: () => {},
  }), /ticket missing/)
  assert.equal(calls, 3)
})
test('revocation, signature damage and unknown failures fail immediately', t => {
  const f = fixture(t)
  for (const diagnostic of ['CSSMERR_TP_CERT_REVOKED', 'invalid signature', 'code modified', 'unknown failure']) {
    const error = missing(); error.attempts[0].codesign.stderr = diagnostic
    assert.throws(() => verifyAcceptedNotarization(f.file, f.hash, {
      verify: () => { throw error }, wait: () => assert.fail('must not retry'),
    }), /ticket missing/)
  }
  const error = missing(); error.attempts[0].assessment.stderr += 'revoked\n'
  assert.throws(() => verifyAcceptedNotarization(f.file, f.hash, {
    verify: () => { throw error }, wait: () => assert.fail('must not retry'),
  }), /ticket missing/)
})
test('changed bytes cannot borrow the earlier Apple acceptance', t => {
  const f = fixture(t); let calls = 0
  assert.throws(() => verifyAcceptedNotarization(f.file, f.hash, {
    verify: () => { calls++; throw missing() }, report: () => {},
    wait: () => writeFileSync(f.file, 'different bytes'),
  }), /Apple-accepted executable bytes changed/)
  assert.equal(calls, 1)
})
