import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { captureNotarizationDiagnostics, classifyNotarizationEvents, LOG_PREDICATE } from './capture-notarization-diagnostics.mjs'

// Both kinds of red event in job 123591764902 carried this subsystem/category.
const event = message => ({ process: 'syspolicyd', processImagePath: '/usr/libexec/syspolicyd',
  subsystem: 'com.apple.syspolicy', category: 'default', eventMessage: message })
const outage = [
  event('cloudkit request failed: Error Domain=NSURLErrorDomain Code=-1001 UserInfo={sensitive: secret-value}'),
  event('CKTicketStore network reachability: 0, Thu Oct 29 16:47:34 2026'),
]

test('the real Apple predicate admits the captured red metadata and excludes unrelated host traffic',
  { skip: process.platform !== 'darwin' }, () => {
    const fixtures = [...outage, { ...outage[0], subsystem: 'unrelated.subsystem' },
      { ...outage[0], process: 'unrelated-process' }, { ...outage[0], eventMessage: 'ordinary ticket lookup' }]
    const script = `ObjC.import('Foundation');
      const predicate = $.NSPredicate.predicateWithFormat(${JSON.stringify(LOG_PREDICATE)});
      const fixtures = ${JSON.stringify(fixtures)};
      JSON.stringify(fixtures.map(value => Boolean(predicate.evaluateWithObject($(value)))));`
    const actual = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 10000 })
    assert.deepEqual(JSON.parse(actual), [true, true, false, false, false])
  })

test('classifies the captured daemon timeout and emits only allowlisted observations', () => {
  const receipt = classifyNotarizationEvents(outage)
  assert.equal(receipt.classification, 'ticket-service-network-timeout')
  assert.deepEqual(receipt.network_error_codes, [-1001])
  assert.deepEqual(receipt.ticket_store_reachability, [0])
  assert.doesNotMatch(JSON.stringify(receipt), /secret-value|UserInfo|cloudkit request|sensitive/)
})

test('a network outage cannot obscure revocation, damaged signatures or certificate errors', () => {
  for (const diagnostic of ['CSSMERR_TP_CERT_REVOKED', 'invalid signature', 'code or signature have been modified']) {
    assert.equal(classifyNotarizationEvents([...outage, event(diagnostic)]).classification, 'security-rejection-observed')
  }
  assert.equal(classifyNotarizationEvents([...outage, event('cloudkit request failed: NSURLErrorDomain Code=-1202')]).classification,
    'unknown-ticket-error-observed')
})

test('foreign processes, ordinary trustd timeouts and a missing reachability signal do not establish a ticket outage', () => {
  for (const events of [
    outage.map(entry => ({ ...entry, processImagePath: '/some/foreign-process' })),
    outage.map(entry => ({ ...entry, processImagePath: '/usr/libexec/trustd' })),
    [outage[0]], [outage[1]], [],
  ]) assert.equal(classifyNotarizationEvents(events).classification, 'no-ticket-network-evidence')
})

test('capture bounds the original acquisition window, command duration and raw output', () => {
  const now = new Date('2026-10-29T17:00:00Z')
  const receipt = captureNotarizationDiagnostics({ start: '2026-10-29 16:00:00+0000', now, platform: 'darwin',
    run: (command, args, options) => {
      assert.equal(command, '/usr/bin/log')
      assert.equal(args[args.indexOf('--start') + 1], '2026-10-29 16:55:00+0000')
      assert.equal(args[args.indexOf('--end') + 1], '2026-10-29 17:00:00+0000')
      assert.equal(options.timeout, 15000)
      assert.equal(options.maxBuffer, 1024 * 1024)
      return { status: 0, stdout: JSON.stringify(outage) }
    } })
  assert.equal(receipt.capture_status, 'complete')
  assert.equal(receipt.classification, 'ticket-service-network-timeout')
  assert.match(receipt.admission, /^unchanged/)
})

test('unavailable or malformed system logs produce bounded parseable receipts without leaking raw output', () => {
  for (const response of [
    { status: 1, stderr: 'secret-value', error: { code: 'ENOBUFS', message: 'secret-value' } },
    { status: 0, stdout: 'secret-value' }, { status: 0, stdout: '{}' },
  ]) {
    const receipt = captureNotarizationDiagnostics({ start: '2026-10-29 16:59:00+0000', now: new Date('2026-10-29T17:00:00Z'),
      platform: 'darwin', run: () => response })
    assert.notEqual(receipt.capture_status, 'complete')
    assert.equal(receipt.classification, 'no-ticket-network-evidence')
    assert.doesNotMatch(JSON.stringify(receipt), /secret-value/)
  }
})

test('missing, invalid or future acquisition markers never query system logs', () => {
  for (const start of [undefined, 'secret-value', '2026-10-29 18:00:00+0000']) {
    const receipt = captureNotarizationDiagnostics({ start, now: new Date('2026-10-29T17:00:00Z'), platform: 'darwin',
      run: () => assert.fail('must not inspect system logs') })
    assert.notEqual(receipt.capture_status, 'complete')
    assert.doesNotMatch(JSON.stringify(receipt), /secret-value/)
  }
})
