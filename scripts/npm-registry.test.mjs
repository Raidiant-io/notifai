import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isRegistryNotFound,
  lookupPublishedTarball,
  REGISTRY_LOOKUP_ATTEMPTS,
} from './npm-registry.mjs'

function registry404() {
  return Object.assign(new Error('npm view failed'), {
    stderr: Buffer.from('npm error code E404\nnpm error 404 Not Found'),
  })
}

test('npm E404 propagation failures retry with bounded exponential backoff', async () => {
  let calls = 0
  const waits = []
  const retries = []
  const tarball = await lookupPublishedTarball('@raidiant/example@1.2.3', {
    lookup: () => {
      calls += 1
      if (calls < 3) throw registry404()
      return 'https://registry.example/package.tgz'
    },
    wait: async milliseconds => waits.push(milliseconds),
    onRetry: retry => retries.push(retry),
  })

  assert.equal(tarball, 'https://registry.example/package.tgz')
  assert.equal(calls, 3)
  assert.deepEqual(waits, [1000, 2000])
  assert.deepEqual(retries, [
    {attempt: 1, delayMs: 1000},
    {attempt: 2, delayMs: 2000},
  ])
})

test('a genuinely missing package fails after the bounded attempt ceiling', async () => {
  let calls = 0
  const waits = []
  await assert.rejects(
    lookupPublishedTarball('@raidiant/missing@1.2.3', {
      lookup: () => {
        calls += 1
        throw registry404()
      },
      wait: async milliseconds => waits.push(milliseconds),
      onRetry: () => {},
    }),
    error => isRegistryNotFound(error),
  )

  assert.equal(calls, REGISTRY_LOOKUP_ATTEMPTS)
  assert.deepEqual(waits, [1000, 2000, 4000, 8000])
})

test('non-propagation verification failures do not retry', async () => {
  let calls = 0
  const waits = []
  await assert.rejects(
    lookupPublishedTarball('@raidiant/example@1.2.3', {
      lookup: () => {
        calls += 1
        throw new Error('registry authentication failed')
      },
      wait: async milliseconds => waits.push(milliseconds),
      onRetry: () => {},
    }),
    /registry authentication failed/,
  )

  assert.equal(calls, 1)
  assert.deepEqual(waits, [])
})
