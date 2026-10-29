#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const windowMs = 5 * 60 * 1000
const transportCodes = new Set([-1001, -1003, -1004, -1005, -1006, -1009])
const logTime = date => date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+0000')
export const LOG_PREDICATE = '(process == "syspolicyd" OR process == "trustd") AND ' +
  '(subsystem == "com.apple.syspolicy" OR subsystem == "com.apple.CFNetwork" OR subsystem == "com.apple.securityd") AND ' +
  '(eventMessage CONTAINS[c] "cloudkit request failed:" OR eventMessage CONTAINS[c] "CKTicketStore network reachability:" OR ' +
  'eventMessage CONTAINS[c] "revoked" OR eventMessage CONTAINS[c] "CSSMERR_TP_" OR ' +
  'eventMessage CONTAINS[c] "invalid signature" OR eventMessage CONTAINS[c] "code or signature have been modified")'

export function classifyNotarizationEvents(events) {
  if (!Array.isArray(events)) throw new Error('Expected a system-log event array')
  const codes = new Set(), reachability = new Set()
  let securityRejection = false, unknownError = false, observed = 0
  for (const event of events) {
    const process = path.basename(String(event.processImagePath ?? ''))
    if (!['syspolicyd', 'trustd'].includes(process) || typeof event.eventMessage !== 'string') continue
    const message = event.eventMessage
    if (message.length > 16384) continue
    if (/revoked|CSSMERR_TP_|invalid signature|code or signature have been modified/i.test(message)) {
      securityRejection = true; observed++
    }
    if (process !== 'syspolicyd') continue
    if (/cloudkit request failed:/i.test(message)) {
      observed++
      const code = /NSURLErrorDomain\s+Code=(-\d{1,5})\b/.exec(message)?.[1]
      if (code && transportCodes.has(Number(code))) codes.add(Number(code))
      else unknownError = true
    }
    const reachable = /CKTicketStore network reachability: ([01])\b/.exec(message)?.[1]
    if (reachable !== undefined) { reachability.add(Number(reachable)); observed++ }
  }
  const classification = securityRejection ? 'security-rejection-observed'
    : unknownError ? 'unknown-ticket-error-observed'
      : reachability.has(0) && codes.has(-1001) ? 'ticket-service-network-timeout'
        : reachability.has(0) && codes.size ? 'ticket-service-network-unavailable'
          : 'no-ticket-network-evidence'
  return { classification, network_error_codes: [...codes].sort((a, b) => a - b),
    ticket_store_reachability: [...reachability].sort(), security_rejection_observed: securityRejection,
    unknown_ticket_error_observed: unknownError, observed_event_count: observed }
}

export function captureNotarizationDiagnostics({ start, now = new Date(), platform = process.platform, run = spawnSync }) {
  const receipt = { schema: 1, event: 'cli.notarization.failure-diagnostics', observed_at: now.toISOString(),
    capture_status: 'not-started', classification: 'no-ticket-network-evidence',
    admission: 'unchanged;diagnostics-never-grant-acceptance' }
  if (platform !== 'darwin') return { ...receipt, capture_status: 'unsupported-platform' }
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+0000$/.test(start ?? '')) return receipt
  const since = new Date(start.replace(' ', 'T').replace('+0000', 'Z'))
  if (!Number.isFinite(since.valueOf()) || since > now) return { ...receipt, capture_status: 'invalid-window' }
  const lower = new Date(Math.max(since.valueOf(), now.valueOf() - windowMs))
  const result = run('/usr/bin/log', ['show', '--style', 'json', '--info', '--debug', '--timezone', 'UTC',
    '--start', logTime(lower), '--end', logTime(now), '--predicate', LOG_PREDICATE], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const scope = { window_start: lower.toISOString(), window_end: now.toISOString() }
  if (result.status !== 0 || result.signal || result.error) {
    const known = ['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES'].includes(result.error?.code) ? result.error.code : 'unavailable'
    return { ...receipt, ...scope, capture_status: 'failed', capture_error: known }
  }
  try {
    return { ...receipt, ...scope, capture_status: 'complete', ...classifyNotarizationEvents(JSON.parse(result.stdout)) }
  } catch { return { ...receipt, ...scope, capture_status: 'invalid-log-response' } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [startFile, outputFile] = process.argv.slice(2)
  if (!startFile || !outputFile || process.argv.length !== 4) {
    console.error('Usage: capture-notarization-diagnostics.mjs <acquisition-start-file> <receipt-file>')
    process.exitCode = 1
  } else {
    let start
    try { start = readFileSync(startFile, 'utf8').trim() } catch { start = undefined }
    const receipt = captureNotarizationDiagnostics({ start })
    try {
      writeFileSync(outputFile, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      console.log(JSON.stringify(receipt))
    } catch {
      console.error('Could not write notarization diagnostic receipt')
      process.exitCode = 1
    }
  }
}
