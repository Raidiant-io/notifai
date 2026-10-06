import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { RELEASE_TARGETS } from '../apps/cli/dist/release-distribution.js'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function fixture() {
  const sourceRevision = 'a'.repeat(40), names = ['inventory.json', 'bootstrap.tsv', ...RELEASE_TARGETS.map(target =>
    `notifai-1.0.0-${target.slice(4)}.${target.includes('windows') ? 'zip' : 'tar.gz'}`)]
  const assets = new Map(names.map(name => { const bytes = Buffer.from(`fixture ${name}`); return [name, { bytes: bytes.length, sha256: hash(bytes), read: () => bytes }] }))
  const bundle = { inventory: { version: '1.0.0', source_revision: sourceRevision }, signedInventory: 'fixture inventory', assets }
  const state = { release: { id: 1, tag_name: 'v1.0.0', prerelease: false, draft: true, immutable: false, assets: [] },
    otherReleases: [{ id: 2, tag_name: 'v0.9.0', prerelease: false, draft: false, immutable: true, assets: [] }],
    calls: [], nextId: 10, failUploadResponse: false, failPublishResponse: false }
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), method = options.method ?? 'GET', route = url.pathname.replace('/repos/Raidiant-io/notifai', '')
    state.calls.push({ method, route, name: url.searchParams.get('name') })
    assert.equal(options.redirect, 'error', 'Credential-bearing requests must never follow redirects')
    const response = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status })
    // The job's token is least-privilege, as GitHub serves it: no repository
    // administration reads, and no by-tag address for a release still in draft.
    if (route === '/private-vulnerability-reporting') return response({ enabled: true })
    if (route === '/immutable-releases') return response({ message: 'Resource not accessible by integration' }, 403)
    if (route === '/git/ref/tags/v1.0.0') return response({ object: { type: 'commit', sha: sourceRevision } })
    if (route === '/releases/tags/v1.0.0') return state.release.draft ? response({ message: 'Not Found' }, 404) : response(state.release)
    if (method === 'GET' && route === '/releases') {
      assert.equal(url.searchParams.get('per_page'), '100')
      return response(url.searchParams.get('page') === '1' ? [...state.otherReleases, state.release] : [])
    }
    if (method === 'GET' && route === '/releases/1') return response(state.release)
    if (method === 'DELETE' && route.startsWith('/releases/assets/')) {
      const id = Number(route.split('/').at(-1))
      const asset = state.release.assets.find(item => item.id === id)
      assert.ok(state.release.draft && asset.state === 'starter' && asset.size === 0)
      state.release.assets = state.release.assets.filter(item => item.id !== id)
      return response(null, 204)
    }
    if (method === 'POST' && route === '/releases/1/assets') {
      assert.equal(url.origin, 'https://uploads.github.com')
      assert.ok(state.release.draft)
      const name = url.searchParams.get('name')
      assert.ok(!state.release.assets.some(item => item.name === name), 'Completed asset upload was repeated')
      const asset = { id: state.nextId++, name, size: options.body.length, digest: `sha256:${hash(options.body)}`, state: 'uploaded' }
      state.release.assets.push(asset)
      if (state.failUploadResponse) { state.failUploadResponse = false; return response({}, 502) }
      // The upload response may precede the digest GitHub computes for the listing.
      return response({ ...asset, digest: null }, 201)
    }
    if (method === 'PATCH' && route === '/releases/1') {
      assert.equal(state.release.assets.length, names.length, 'Publication happened before all assets were admitted')
      state.release.draft = false; state.release.immutable = true
      if (state.failPublishResponse) { state.failPublishResponse = false; return response({}, 502) }
      return response(state.release)
    }
    throw new Error(`Unexpected test request ${method} ${route}`)
  }
  return { state, args: { bundle, sourceRevision, token: 'fixture', fetchImpl, delay: async () => {} } }
}
