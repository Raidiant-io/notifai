import assert from 'node:assert/strict'
import test from 'node:test'
import { downloadPublishedTarball } from './npm-registry.mjs'

const NAME = '@raidiant/example'
const VERSION = '1.2.3'
const METADATA = 'https://registry.npmjs.org/%40raidiant%2Fexample/1.2.3'
const TARBALL = 'https://registry.npmjs.org/@raidiant/example/-/example-1.2.3.tgz'

function registry({ metadataAvailable = 0, tarballAvailable = 0, tarballStatus = 404, url = TARBALL } = {}) {
  let now = 0
  const requests = []
  const options = {
    now: () => now,
    wait: async milliseconds => { now += milliseconds },
    warn: () => {},
    fetchImpl: async input => {
      const endpoint = String(input)
      requests.push({ endpoint, now })
      if (endpoint === METADATA) {
        return now < metadataAvailable ? new Response(null, { status: 404 }) : Response.json({ dist: { tarball: url } })
      }
      assert.equal(endpoint, TARBALL)
      return now < tarballAvailable ? new Response(null, { status: tarballStatus }) : new Response('exact npm artifact')
    },
  }
  return { requests, options }
}

test('waits past observed metadata lag and catches tarballs that appear in the final backoff interval', async () => {
  const { requests, options } = registry({ metadataAvailable: 5 * 60_000, tarballAvailable: 590_000 })

  const bytes = await downloadPublishedTarball(NAME, VERSION, options)

  assert.deepEqual(bytes, Buffer.from('exact npm artifact'))
  assert.deepEqual(requests.slice(0, 3).map(request => request.now), [0, 1000, 3000])
  assert.ok(requests.filter(request => request.endpoint === TARBALL).length > 1)
  assert.ok(requests.at(-1).now >= 590_000 && requests.at(-1).now < 600_000)
})

test('persistent metadata and tarball 404s share one bounded deadline', async () => {
  for (const [metadataAvailable, missing] of [[Infinity, 'version metadata'], [9 * 60_000, 'tarball']]) {
    const { requests, options } = registry({ metadataAvailable, tarballAvailable: Infinity })

    await assert.rejects(downloadPublishedTarball(NAME, VERSION, options), new RegExp(`${missing}.*HTTP 404`))

    assert.ok(requests.at(-1).now >= 9.5 * 60_000)
    assert.ok(requests.at(-1).now < 10 * 60_000)
  }
})

test('a non-404 download failure stops on its first read', async () => {
  const { requests, options } = registry({ tarballAvailable: Infinity, tarballStatus: 403 })

  await assert.rejects(downloadPublishedTarball(NAME, VERSION, options), /HTTP 403/)

  assert.deepEqual(requests, [{ endpoint: METADATA, now: 0 }, { endpoint: TARBALL, now: 0 }])
})

test('rejects metadata pointing at a foreign tarball origin before fetching it', async () => {
  const { requests, options } = registry({ url: 'https://example.invalid/example.tgz' })

  await assert.rejects(downloadPublishedTarball(NAME, VERSION, options), /canonical npm origin/)

  assert.deepEqual(requests, [{ endpoint: METADATA, now: 0 }])
})
