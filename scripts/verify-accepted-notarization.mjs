import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { verifyNotarization } from '../apps/cli/npm/notarization.mjs'

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Only the protected signer calls this after both Apple's submission and log
// report Accepted. Never use an unauthenticated expected hash as acceptance.
export function verifyAcceptedNotarization(file, acceptedSha256, {
  verify = verifyNotarization, wait = pause,
  report = entry => console.error(`notifai-accepted-ticket: ${JSON.stringify(entry)}`),
} = {}) {
  assert.match(acceptedSha256, /^[a-f0-9]{64}$/)
  const delays = [60_000, 180_000]
  for (let attempt = 0; ; attempt++) {
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), acceptedSha256,
      'Apple-accepted executable bytes changed')
    try { return verify(file) } catch (error) {
      const last = error.attempts?.at(-1)
      const codesign = last?.codesign, assessment = last?.assessment
      const missing = error.code === 'NOTARIZATION_VERIFICATION_FAILED' &&
        codesign?.status === 3 && !codesign.error && !codesign.signal &&
        /test-requirement: code failed to satisfy specified code requirement\(s\)/.test(codesign.stderr) &&
        !/revoked|CSSMERR_TP_|invalid signature|modified|rejected/i.test(codesign.stderr + codesign.stdout) &&
        assessment?.status === 3 && !assessment.error && !assessment.signal &&
        /^source=Unnotarized Developer ID\s*$/m.test(assessment.stderr) &&
        !/revoked|CSSMERR_TP_|invalid signature|modified/i.test(assessment.stderr + assessment.stdout)
      if (!missing || attempt >= delays.length) throw error
      report({ attempt: attempt + 1, classification: 'accepted-ticket-not-yet-visible',
        accepted_sha256: acceptedSha256, delay_ms: delays[attempt], codesign, assessment })
      wait(delays[attempt])
    }
  }
}
