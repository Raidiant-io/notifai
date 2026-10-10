import { expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { inspectIntegrationQuiescence } from './commands-integration-recovery.js'
import type { IntegrationOperation } from './installation.js'
import { canonicalPath } from './local-path.js'

const scope = canonicalPath(path.join(os.tmpdir(), 'scoped-hermes-recovery', 'plugins', 'notifai'))
const operation: IntegrationOperation = { token: 'recorded', scope, operation: 'enable', build: 'a'.repeat(64), owner: { pid: 11, start: 'owner-start' } }
const writer = { pid: 42, start: 'Sat Oct 10 18:27:00 2026' }
const observation = { schema: 1, domain: 'local-classic-cli', scope, publication: 'all-writers-observed-stopped', competing_publishers: 'paused', writers: [writer] }

it('requires the operator-observed local publication pause and exact physical scope', () => {
  expect(() => inspectIntegrationQuiescence(observation, operation, () => 'gone')).not.toThrow()
  for (const change of [{ domain: 'container' }, { domain: 'unknown' }, { scope: path.dirname(scope) },
    { publication: 'caller-gone' }, { competing_publishers: 'unknown' }, { writers: [{ pid: 42 }] },
    { writers: [{ pid: 42, start: '2026-10-10T18:27:00Z' }] }, { writers: [{ pid: 42, start: 'host-writer-start' }] }]) {
    expect(() => inspectIntegrationQuiescence({ ...observation, ...change }, operation, () => 'gone')).toThrow(/independently observed/)
  }
})

it.each(['alive', 'unknown'] as const)('preserves the reservation when an independently identified child is %s', state => {
  expect(() => inspectIntegrationQuiescence(observation, operation, identity => {
    expect(identity).toEqual(writer)
    return state
  })).toThrow(/writer is still running or uncertain/)
})
