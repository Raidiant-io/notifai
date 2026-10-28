import { spawnSync } from 'node:child_process'

const backoff = [5000, 15000, 40000]
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const rejected = text => /revoked|CSSMERR_TP_|invalid signature|code or signature have been modified|\brejected\b/i.test(text)
const damaged = text => /revoked|CSSMERR_TP_|invalid signature|modified/i.test(text)
// Only transport failures: certificate/TLS failures and unknown errors remain fatal.
const unavailable = text => /NSURLErrorDomain\s+Code=-(?:1001|1003|1004|1005|1006|1009)\b/.test(text)
const snapshot = result => ({ status: result.status, signal: result.signal ?? null,
  error: result.error?.code ?? null, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') })
const clean = result => !result.error && !result.signal
// Apple's public ticket store, the same record Gatekeeper's online check reads.
export const TICKET_SERVICE = 'https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup'

// Ask Apple directly whether it holds a notarization ticket for this file's
// exact code. The answer only decides whether a local lookup is worth
// repeating; admission still requires a later local codesign success.
export function lookupAppleTicket(file, run, options) {
  const display = snapshot(run('/usr/bin/codesign', ['--display', '-vvv', file], options))
  const cdhash = clean(display) && display.status === 0 &&
    /^CandidateCDHashFull sha256=([0-9a-f]{64})\s*$/m.exec(display.stderr + display.stdout)?.[1]
  if (!cdhash) return { answer: 'unknown', reason: 'no-sha256-cdhash' }
  // Gatekeeper's record name: format 2, hash type 2 (SHA-256 truncated to 20 bytes).
  const record = `2/2/${cdhash.slice(0, 40)}`
  // -q first: never read a user's ~/.curlrc, which could change trust or output.
  const response = snapshot(run('/usr/bin/curl', ['-q', '--silent', '--show-error', '--proto', '=https', '--tlsv1.2',
    '--max-time', '10', '--request', 'POST', '--header', 'Content-Type: application/json',
    '--data', JSON.stringify({ records: [{ recordName: record }] }), '--write-out', '\n%{http_code}', TICKET_SERVICE], options))
  const lines = response.stdout.trimEnd().split('\n'), http = lines.pop()
  let found
  try { found = JSON.parse(lines.join('\n')).records?.[0] } catch { found = undefined }
  const evidence = { record, http: http ?? null, curl: response.status, server_error: found?.serverErrorCode ?? null }
  if (!clean(response) || response.status !== 0 || http !== '200' || found?.recordName !== record) {
    return { answer: 'unavailable', ...evidence, stderr: response.stderr.slice(-500) }
  }
  if (found.serverErrorCode === 'NOT_FOUND' && !found.recordType) return { answer: 'absent', ...evidence }
  if (found.recordType === 'DeveloperIDTicket' && !found.serverErrorCode &&
    typeof found.fields?.signedTicket?.value === 'string' && found.fields.signedTicket.value.length > 0) {
    return { answer: 'held', ...evidence }
  }
  return { answer: 'unavailable', ...evidence }
}

// A requirement failure alone cannot distinguish a missing/rejected ticket from
// an unavailable lookup. Never retry it on the strength of that message alone.
// Gatekeeper's independent positive notarized assessment, or Apple's ticket
// store holding a ticket for these exact bytes, establishes a lookup
// inconsistency; even then, only a subsequent codesign success admits the file.
export function verifyNotarization(file, { run = spawnSync, pause: wait = pause,
  report = entry => console.error(`notifai-notarization: ${JSON.stringify(entry)}`) } = {}) {
  const history = []
  for (let attempt = 1; attempt <= backoff.length + 1; attempt += 1) {
    const options = { encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
    const codesign = snapshot(run('/usr/bin/codesign', ['-vvvv', '-R=notarized', '--check-notarization', file], options))
    if (codesign.status === 0 && clean(codesign)) {
      return { stdout: codesign.stdout, stderr: codesign.stderr, attempts: attempt, failures: history }
    }
    let classification = 'rejected-or-unknown', assessment, ticket
    const diagnostic = codesign.stderr + codesign.stdout
    if (clean(codesign) && !rejected(diagnostic)) {
      if (unavailable(diagnostic)) classification = 'lookup-unavailable'
      else if (diagnostic.includes('code failed to satisfy specified code requirement(s)')) {
        assessment = snapshot(run('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'install', file], options))
        const detail = assessment.stderr + assessment.stdout
        if (clean(assessment) && !rejected(detail)) {
          if (assessment.status === 0 && /^source=Notarized Developer ID\s*$/m.test(detail) && /: accepted\s*$/m.test(detail)) {
            classification = 'lookup-inconsistent'
          } else if (unavailable(detail)) classification = 'lookup-unavailable'
        } else if (clean(assessment) && assessment.status === 3 && /: rejected\s*$/m.test(detail) &&
          /^source=Unnotarized Developer ID\s*$/m.test(detail) && !damaged(detail) &&
          /satisfies its Designated Requirement/.test(diagnostic)) {
          // A valid Developer ID signature that this Mac reports as unnotarized:
          // either Apple has no ticket, or this Mac's lookup did not find it.
          ticket = lookupAppleTicket(file, run, options)
          classification = ticket.answer === 'held' ? 'lookup-inconsistent'
            : ticket.answer === 'unavailable' ? 'lookup-unavailable'
              : ticket.answer === 'absent' ? 'not-notarized' : 'rejected-or-unknown'
        }
      }
    }
    const entry = { attempt, classification, codesign, ...(assessment ? { assessment } : {}), ...(ticket ? { ticket } : {}) }
    history.push(entry)
    report(entry)
    if (classification === 'rejected-or-unknown' || classification === 'not-notarized' || attempt > backoff.length) {
      const error = new Error(`Apple notarization verification failed (${classification}, attempt ${attempt}): ${JSON.stringify(history)}`)
      error.code = 'NOTARIZATION_VERIFICATION_FAILED'
      error.attempts = history
      throw error
    }
    wait(backoff[attempt - 1])
  }
}
