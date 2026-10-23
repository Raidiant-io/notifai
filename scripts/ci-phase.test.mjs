import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const run = (timeout, source) => spawnSync(process.execPath, ['scripts/ci-phase.mjs', 'fixture', String(timeout), 'node', '-e', source], { encoding: 'utf8', timeout: 20_000 })
test('reports the failed phase without retrying an assertion failure', () => {
  const result = run(5000, 'console.log("attempt"); process.exit(7)')
  assert.equal(result.status, 1)
  assert.equal(result.stdout.trim(), 'attempt')
  assert.match(result.stderr, /phase fixture exited 7/)
})
test('bounds a blocked child and reports its process tree', () => {
  const result = run(500, `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)`)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /process-tree snapshot/)
  assert.match(result.stderr, /phase fixture timed out/)
})
test('passes through successful completion', () => {
  const result = run(5000, 'console.log("complete")')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /complete/)
})
