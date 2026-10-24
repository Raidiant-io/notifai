import { spawnSync } from 'node:child_process'

const backoff = [5000, 15000]
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const rejected = text => /revoked|CSSMERR_TP_|invalid signature|code or signature have been modified|\brejected\b/i.test(text)
// Only transport failures: certificate/TLS failures and unknown errors remain fatal.
const unavailable = text => /NSURLErrorDomain\s+Code=-(?:1001|1003|1004|1005|1006|1009)\b/.test(text)
const snapshot = result => ({ status: result.status, signal: result.signal ?? null,
  error: result.error?.code ?? null, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') })

// A requirement failure alone cannot distinguish a missing/rejected ticket from
// an unavailable lookup. Never retry it on the strength of that message alone.
// Gatekeeper's independent positive notarized assessment establishes a lookup
// inconsistency; even then, only a subsequent codesign success admits the file.
export function verifyNotarization(file, { run = spawnSync, pause: wait = pause,
  report = entry => console.error(`notifai-notarization: ${JSON.stringify(entry)}`) } = {}) {
  const history = []
  for (let attempt = 1; attempt <= backoff.length + 1; attempt += 1) {
    const options = { encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
    const codesign = snapshot(run('/usr/bin/codesign', ['-vvvv', '-R=notarized', '--check-notarization', file], options))
    if (codesign.status === 0 && !codesign.error && !codesign.signal) {
      return { stdout: codesign.stdout, stderr: codesign.stderr, attempts: attempt, failures: history }
    }
    let classification = 'rejected-or-unknown', assessment
    const diagnostic = codesign.stderr + codesign.stdout
    if (!codesign.error && !codesign.signal && !rejected(diagnostic)) {
      if (unavailable(diagnostic)) classification = 'lookup-unavailable'
      else if (diagnostic.includes('code failed to satisfy specified code requirement(s)')) {
        assessment = snapshot(run('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'install', file], options))
        const detail = assessment.stderr + assessment.stdout
        if (!assessment.error && !assessment.signal && !rejected(detail)) {
          if (assessment.status === 0 && /^source=Notarized Developer ID\s*$/m.test(detail) && /: accepted\s*$/m.test(detail)) {
            classification = 'lookup-inconsistent'
          } else if (unavailable(detail)) classification = 'lookup-unavailable'
        }
      }
    }
    const entry = { attempt, classification, codesign, ...(assessment ? { assessment } : {}) }
    history.push(entry)
    report(entry)
    if (classification === 'rejected-or-unknown' || attempt > backoff.length) {
      const error = new Error(`Apple notarization verification failed (${classification}, attempt ${attempt}): ${JSON.stringify(history)}`)
      error.code = 'NOTARIZATION_VERIFICATION_FAILED'
      error.attempts = history
      throw error
    }
    wait(backoff[attempt - 1])
  }
}
