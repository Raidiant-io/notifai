import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { Distribution, RELEASE_TARGETS, releaseSigningMessage } from '../apps/cli/dist/release-distribution.js'
import { bootstrapInventoryText } from './generate-bootstrap-metadata.mjs'
import { publishNativeAssets } from './publish-native-assets.mjs'
import { advanceNativeChannel } from './advance-native-channel.mjs'
import { fixture } from './native-publication.test-support.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
async function setup() {
  const f = fixture(), { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const trustedKeys = { fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const distribution = new Distribution(trustedKeys)
  const payload = Buffer.from(JSON.stringify({ schema: 1, version: '1.0.0', source_revision: f.args.sourceRevision,
    store_schema: 1, launcher_schema: 1, artifacts: RELEASE_TARGETS.map(target => {
      const filename = `notifai-1.0.0-${target.slice(4)}.${target.includes('windows') ? 'zip' : 'tar.gz'}`
      return { target, filename, bytes: f.args.bundle.assets.get(filename).bytes, sha256: f.args.bundle.assets.get(filename).sha256,
        runtime_sha256: 'a'.repeat(64), launcher_sha256: 'b'.repeat(64), materials: [] }
    }) }))
  const signedInventory = JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
    signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') })
  f.args.bundle.signedInventory = signedInventory
  f.args.bundle.inventory = distribution.verifyInventory(signedInventory)
  for (const [name, value] of [['inventory.json', signedInventory], ['bootstrap.tsv', bootstrapInventoryText(distribution, signedInventory)]]) {
    const bytes = Buffer.from(value); f.args.bundle.assets.set(name, { bytes: bytes.length, sha256: hash(bytes), read: () => bytes })
  }
  await publishNativeAssets(f.args)
  f.state.calls = []
  const git = { head: 'c'.repeat(40), trees: new Map([['d'.repeat(40), new Map([['README.md', 'preserve this metadata file']])]]),
    commits: new Map([['c'.repeat(40), { tree: 'd'.repeat(40), parents: [] }]]), blobs: new Map(), calls: [], next: 1, race: false }
  const id = () => (git.next++).toString(16).padStart(40, '0')
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status })
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), route = url.pathname.replace('/repos/Raidiant-io/notifai', ''), method = options.method ?? 'GET'
    if (route === '/graphql') {
      const body = JSON.parse(options.body), change = body.variables.input
      git.calls.push({ method, route, body })
      assert.equal(change.expectedHeadOid, git.head)
      assert.deepEqual(change.branch, { repositoryNameWithOwner: 'Raidiant-io/notifai', branchName: 'release-metadata' })
      if (git.race) return response({ errors: [{ message: 'Expected head differs' }] })
      const tree = new Map(git.trees.get(git.commits.get(git.head).tree))
      assert.deepEqual(change.fileChanges.additions.map(item => item.path).sort(), ['stable.bootstrap.tsv', 'stable.json'])
      for (const file of change.fileChanges.additions) tree.set(file.path, Buffer.from(file.contents, 'base64').toString())
      const treeId = id(), commitId = id()
      git.trees.set(treeId, tree); git.commits.set(commitId, { tree: treeId, parents: [git.head] }); git.head = commitId
      return response({ data: { createCommitOnBranch: { commit: { oid: commitId } } } })
    }
    if (!route.includes('release-metadata') && !route.startsWith('/contents/') &&
        !['/git/blobs', '/git/trees', '/git/commits', '/git/refs'].includes(route) && !route.startsWith('/git/commits/')) return f.args.fetchImpl(input, options)
    const body = options.body ? JSON.parse(options.body) : null
    git.calls.push({ method, route, body })
    if (route === '/git/ref/heads/release-metadata') return git.head ? response({ object: { type: 'commit', sha: git.head } }) : response({}, 404)
    if (route.startsWith('/contents/')) {
      const commit = git.commits.get(url.searchParams.get('ref')), contents = git.trees.get(commit.tree).get(route.slice('/contents/'.length))
      return contents === undefined ? response({}, 404) : response({ type: 'file', encoding: 'base64', size: Buffer.byteLength(contents), content: Buffer.from(contents).toString('base64') })
    }
    if (method === 'GET' && route.startsWith('/git/commits/')) return response({ tree: { sha: git.commits.get(route.split('/').at(-1)).tree } })
    if (route === '/git/blobs') { const sha = id(); git.blobs.set(sha, Buffer.from(body.content, 'base64').toString()); return response({ sha }, 201) }
    if (route === '/git/trees') {
      const sha = id(), tree = new Map(git.trees.get(body.base_tree))
      assert.deepEqual(body.tree.map(item => item.path).sort(), ['stable.bootstrap.tsv', 'stable.json'])
      for (const item of body.tree) tree.set(item.path, git.blobs.get(item.sha))
      git.trees.set(sha, tree); return response({ sha }, 201)
    }
    if (route === '/git/commits') { const sha = id(); git.commits.set(sha, body); return response({ sha }, 201) }
    if (route === '/git/refs' && method === 'POST') {
      assert.equal(body.ref, 'refs/heads/release-metadata')
      if (git.race || git.head) return response({}, 422)
      git.head = body.sha; return response({ object: { type: 'commit', sha: git.head } })
    }
    throw new Error(`Unexpected channel fixture request ${method} ${route}`)
  }
  const files = () => git.trees.get(git.commits.get(git.head).tree)
  return { git, files, distribution, args: { ...f.args, fetchImpl, channel: 'stable', privateKey, trustedKeys, keyId: 'fixture' } }
}
test('channel initialization is explicit; one commit publishes JSON and view while preserving other metadata; retries do not write', async () => {
  const f = await setup()
  await assert.rejects(advanceNativeChannel(f.args), /initialization must be explicit/)
  assert.ok(f.git.calls.every(call => call.method === 'GET'))
  const result = await advanceNativeChannel({ ...f.args, initialize: true })
  assert.equal(result.sequence, 1)
  assert.equal(f.files().get('README.md'), 'preserve this metadata file')
  assert.match(f.files().get('stable.bootstrap.tsv'), /^notifai-channel-v1\tstable\t1\t/)
  assert.equal(f.distribution.verifyChannel(f.files().get('stable.json'), 'stable').version, '1.0.0')
  f.git.calls = []
  assert.equal((await advanceNativeChannel(f.args)).changed, false)
  assert.ok(f.git.calls.every(call => call.method === 'GET'))
})
test('a competing metadata ref update is not overwritten or retried with force', async () => {
  const f = await setup(), previousHead = f.git.head
  f.git.race = true
  await assert.rejects(advanceNativeChannel({ ...f.args, initialize: true }), /Channel head changed/)
  assert.equal(f.git.head, previousHead)
  assert.equal(f.files().has('stable.json'), false)
  assert.equal(f.git.calls.filter(call => call.route === '/graphql').length, 1)
  assert.ok(f.git.calls.every(call => call.method !== 'PATCH'))
})

test('a missing metadata branch uses exclusive initial ref creation and never overwrites a concurrent creator', async () => {
  const first = await setup(); first.git.head = null
  assert.equal((await advanceNativeChannel({ ...first.args, initialize: true })).sequence, 1)
  assert.equal(first.distribution.verifyChannel(first.files().get('stable.json'), 'stable').version, '1.0.0')
  const racing = await setup(); racing.git.head = null; racing.git.race = true
  await assert.rejects(advanceNativeChannel({ ...racing.args, initialize: true }), /422/)
  assert.equal(racing.git.head, null)
})
