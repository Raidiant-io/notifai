import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Distribution, releaseSigningMessage, type ReleaseInventory, type ReleaseChannel } from './release-distribution.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const keys = { fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function signed(kind: 'channel' | 'inventory', value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value))
  return JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
    signature: sign(null, releaseSigningMessage(kind, payload), privateKey).toString('base64') })
}
const artifact = Buffer.from('archive-fixture')
const inventory: ReleaseInventory = { schema: 1, version: '12.0.0', source_revision: 'a'.repeat(40),
  store_schema: 1, launcher_schema: 1, artifacts: [{ target: 'bun-windows-x64',
    filename: 'notifai-12.0.0-windows-x64.zip', bytes: artifact.length, sha256: digest(artifact),
    runtime_sha256: 'c'.repeat(64), materials: [], launcher_sha256: 'd'.repeat(64) }] }
function setup(options: { inventory?: ReleaseInventory; sequence?: number; channel?: 'stable' | 'beta';
  corrupt?: boolean; redirect?: boolean; withdrawn?: string[] } = {}) {
  const release = options.inventory ?? inventory
  const manifest = signed('inventory', release)
  const channel = signed('channel', { schema: 1, channel: options.channel ?? 'stable', sequence: options.sequence ?? 3,
    version: release.version, inventory_sha256: digest(manifest), withdrawn_versions: options.withdrawn ?? [] })
  const urls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input); urls.push(url)
    if (options.redirect) return new Response(null, { status: 302, headers: { location: 'https://example.test/untrusted' } })
    if (url.endsWith('/stable.json') || url.endsWith('/beta.json')) return new Response(channel)
    if (url.endsWith('/inventory.json')) return new Response(options.corrupt ? manifest.replace('fixture', 'stranger') : manifest)
    return new Response(artifact)
  }
  return { distribution: new Distribution(keys, fetcher), urls }
}

function twoChannels(betaVersion = '12.0.0-beta.1') {
  const manifests = new Map([betaVersion, '12.0.0'].map(version => [version, signed('inventory', {
    ...inventory, version, artifacts: inventory.artifacts.map(artifact =>
      ({ ...artifact, filename: artifact.filename.replace('12.0.0', version) })),
  })]))
  const channels = {
    beta: { schema: 1, channel: 'beta', sequence: 4, version: betaVersion, inventory_sha256: digest(manifests.get(betaVersion)!), withdrawn_versions: [] as string[] },
    stable: { schema: 1, channel: 'stable', sequence: 8, version: '12.0.0', inventory_sha256: digest(manifests.get('12.0.0')!), withdrawn_versions: [] as string[] },
  }
  const state: { unavailable: ReleaseChannel | null; corrupt: ReleaseChannel | null } = { unavailable: null, corrupt: null }
  const distribution = new Distribution(keys, async input => {
    const url = String(input)
    if (!url.endsWith('/inventory.json')) {
      const name = url.endsWith('/beta.json') ? 'beta' : 'stable'
      if (state.unavailable === name) return new Response(null, { status: 503 })
      const bytes = signed('channel', channels[name])
      return new Response(state.corrupt === name ? bytes.replace('fixture', 'unknown') : bytes)
    }
    return new Response(manifests.get(url.split('/v')[1]!.split('/')[0]!))
  })
  return { distribution, channels, state }
}

describe('verified release distribution', () => {
  it('beta selects the newest authenticated beta or stable and keeps its audience', async () => {
    for (const [betaVersion, expected] of [['12.0.0-beta.1', '12.0.0'], ['13.0.0-beta.1', '13.0.0-beta.1']]) {
      const release = await twoChannels(betaVersion).distribution.resolveRelease({ channel: 'beta', target: 'bun-windows-x64' })
      expect(release.inventory.version).toBe(expected)
      expect(release.channel).toBe('beta')
    }
  })
  it('beta refuses uncertainty or replay on either channel and unions withdrawals and inventory bindings', async () => {
    const options = { channel: 'beta', target: 'bun-windows-x64' } as const
    for (const name of ['beta', 'stable'] as const) {
      const unavailable = twoChannels(); unavailable.state.unavailable = name
      await expect(unavailable.distribution.resolveRelease(options)).rejects.toThrow(/503/)
      const corrupt = twoChannels(); corrupt.state.corrupt = name
      await expect(corrupt.distribution.resolveRelease(options)).rejects.toThrow(/key/)
      const replay = twoChannels()
      const accepted = await replay.distribution.resolveRelease(options)
      replay.channels[name].sequence--
      await expect(replay.distribution.resolveRelease({ ...options, seen: accepted.seen })).rejects.toThrow(/sequence/)
    }
    const withdrawn = twoChannels(); withdrawn.channels.beta.withdrawn_versions.push('12.0.0')
    await expect(withdrawn.distribution.resolveRelease(options)).rejects.toThrow(/withdrawn/)
    const pinned = twoChannels(); pinned.channels.stable.withdrawn_versions.push('12.0.0-beta.1')
    await expect(pinned.distribution.resolveRelease({ ...options, version: '12.0.0-beta.1' })).rejects.toThrow(/withdrawn/)
    const mismatched = twoChannels('12.0.0'); mismatched.channels.beta.inventory_sha256 = 'e'.repeat(64)
    await expect(mismatched.distribution.resolveRelease(options)).rejects.toThrow(/integrity/)
  })
  it('acquires a carried exact inventory without mutable channel selection', async () => {
    const { distribution, urls } = setup()
    const options = { signedInventory: signed('inventory', inventory), version: inventory.version,
      sourceRevision: inventory.source_revision, target: 'bun-windows-x64' as const }
    const release = distribution.resolveExactRelease(options)
    expect(urls).toEqual([])
    expect(await distribution.downloadArtifact(release)).toEqual(artifact)
    expect(urls).toEqual(['https://github.com/Raidiant-io/notifai/releases/download/v12.0.0/notifai-12.0.0-windows-x64.zip'])
    expect(() => distribution.resolveExactRelease({ ...options, version: '11.0.0' })).toThrow(/identity/)
    expect(() => distribution.resolveExactRelease({ ...options, sourceRevision: 'b'.repeat(40) })).toThrow(/identity/)
    expect(() => distribution.resolveExactRelease({ ...options, signedInventory: options.signedInventory.replace('fixture', 'unknown') })).toThrow(/key/)
    expect(() => distribution.resolveExactRelease({ ...options, target: 'bun-linux-arm64' })).toThrow(/target/)
    const redirected = setup({ redirect: true }).distribution.resolveExactRelease(options)
    await expect(setup({ redirect: true }).distribution.downloadArtifact(redirected)).rejects.toThrow(/origin/)
  })
  it('resolves one signed target through fixed origins and verifies the downloaded bytes', async () => {
    const { distribution, urls } = setup()
    const release = await distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })
    expect(release.inventory.version).toBe('12.0.0')
    expect(release.seen.stable?.sequence).toBe(3)
    expect(await distribution.downloadArtifact(release)).toEqual(artifact)
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/Raidiant-io/notifai/release-metadata/stable.json',
      'https://github.com/Raidiant-io/notifai/releases/download/v12.0.0/inventory.json',
      'https://github.com/Raidiant-io/notifai/releases/download/v12.0.0/notifai-12.0.0-windows-x64.zip',
    ])
    expect(() => distribution.verifyArtifact(release.artifact, Buffer.from('altered'))).toThrow(/integrity/)
  })
  it('rejects tampering, unknown keys, cross-purpose signatures, and untrusted redirects', async () => {
    const { distribution } = setup()
    expect(() => distribution.verifyInventory(signed('channel', inventory))).toThrow(/signature/)
    expect(() => distribution.verifyInventory(signed('inventory', inventory).replace('fixture', 'other'))).toThrow(/key/)
    const tampered = JSON.parse(signed('inventory', inventory))
    tampered.payload = Buffer.from(JSON.stringify({ ...inventory, version: '99.0.0' })).toString('base64')
    expect(() => distribution.verifyInventory(JSON.stringify(tampered))).toThrow(/signature/)
    await expect(setup({ corrupt: true }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })).rejects.toThrow(/integrity/)
    await expect(setup({ redirect: true }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })).rejects.toThrow(/origin/)
  })
  it('refuses channel replay, same-sequence substitution, beta leakage and missing targets', async () => {
    const release = await setup().distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })
    await expect(setup({ sequence: 2 }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64', seen: release.seen })).rejects.toThrow(/sequence/)
    await expect(setup({ withdrawn: ['11.0.0'] }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64', seen: release.seen })).rejects.toThrow(/sequence/)
    await expect(setup({ channel: 'beta' }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })).rejects.toThrow(/channel/)
    await expect(setup({ inventory: { ...inventory, version: '12.0.0-beta.1' } }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })).rejects.toThrow(/stable/)
    await expect(setup().distribution.resolveRelease({ channel: 'stable', target: 'bun-linux-arm64' })).rejects.toThrow(/target/)
    await expect(setup({ withdrawn: ['12.0.0'] }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64', version: '12.0.0' })).rejects.toThrow(/withdrawn/)
  })
  it('bounds metadata bodies and redirect chains and refuses signed path escapes', async () => {
    let cancelled = false
    const oversized = new Distribution(keys, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)) },
      cancel() { cancelled = true },
    })))
    await expect(oversized.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })).rejects.toThrow(/size limit/)
    expect(cancelled).toBe(true)
    let calls = 0
    const looping = new Distribution(keys, async () => {
      calls++
      return new Response(null, { status: 302, headers: { location: 'https://github.com/loop' } })
    })
    await expect(looping.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })).rejects.toThrow(/redirects/)
    expect(calls).toBe(5)
    expect(() => setup().distribution.verifyInventory(signed('inventory', {
      ...inventory, artifacts: [{ ...inventory.artifacts[0], filename: '../outside.zip' }],
    }))).toThrow(/filename/)
  })
})
