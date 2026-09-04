import assert from 'node:assert/strict'
import process from 'node:process'
import test from 'node:test'
import { formatPhaseTimeout, requireStatus, runExternal, timedOut } from './run-external.mjs'

test('a hanging process fails the named phase instead of waiting indefinitely', () => {
  assert.throws(
    () =>
      runExternal(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        phase: 'hanging-fixture',
        timeoutMs: 200,
      }),
    (error) => {
      assert.match(error.message, /phase hanging-fixture timed out after 200ms/u)
      assert.match(error.message, /the process did not exit/u)
      return true
    },
  )
})

test('a successful process returns its status and elapsed time', () => {
  const result = runExternal(process.execPath, ['-e', 'process.stdout.write("ok")'], {
    phase: 'echo-fixture',
    timeoutMs: 5_000,
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'ok')
  assert.equal(result.phase, 'echo-fixture')
  assert.ok(result.elapsedMs >= 0)
  assert.ok(result.elapsedMs < 5_000)
})

test('a non-zero exit names the phase and keeps stderr', () => {
  assert.throws(
    () =>
      requireStatus(
        runExternal(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(7)'], {
          phase: 'exit-fixture',
          timeoutMs: 5_000,
        }),
      ),
    (error) => {
      assert.match(error.message, /phase exit-fixture exited 7/u)
      assert.match(error.message, /stderr: boom/u)
      return true
    },
  )
})

test('omitting the timeout is a caller error, not an unbounded spawn', () => {
  assert.throws(
    () => runExternal(process.execPath, ['-e', ''], { phase: 'missing-timeout' }),
    /phase missing-timeout requires a positive timeoutMs/u,
  )
})

test('timeout formatting includes captured output', () => {
  const message = formatPhaseTimeout({
    phase: 'npm-exec-skills-installer',
    timeoutMs: 45_000,
    elapsedMs: 45_012,
    result: { stdout: 'downloading\n', stderr: '', signal: 'SIGKILL' },
  })
  assert.match(message, /phase npm-exec-skills-installer timed out after 45000ms/u)
  assert.match(message, /stdout: downloading/u)
  assert.match(message, /signal: SIGKILL/u)
})

test('ETIMEDOUT is classified as a phase timeout', () => {
  assert.equal(timedOut({ error: { code: 'ETIMEDOUT' } }, 50, 10), true)
  assert.equal(timedOut({ status: 0 }, 50, 10), false)
})
