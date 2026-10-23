import { createHash,generateKeyPairSync,sign } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import { Distribution,releaseSigningMessage,type ReleaseChannel,type ReleaseInventory } from './release-distribution.js'

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
  it('refuses channel replay, same-sequence substitution, beta leakage and missing targets', async () => {
    const release = await setup().distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })
    await expect(setup({ sequence: 2 }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64', seen: release.seen })).rejects.toThrow(/sequence/)
    await expect(setup({ withdrawn: ['11.0.0'] }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64', seen: release.seen })).rejects.toThrow(/sequence/)
    await expect(setup({ channel: 'beta' }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })).rejects.toThrow(/channel/)
    await expect(setup({ inventory: { ...inventory, version: '12.0.0-beta.1' } }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64' })).rejects.toThrow(/stable/)
    await expect(setup().distribution.resolveRelease({ channel: 'stable', target: 'bun-linux-arm64' })).rejects.toThrow(/target/)
    await expect(setup({ withdrawn: ['12.0.0'] }).distribution.resolveRelease({ channel: 'stable', target: 'bun-windows-x64', version: '12.0.0' })).rejects.toThrow(/withdrawn/)
  })
})
