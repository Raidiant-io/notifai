import { createHash, createPublicKey, verify } from 'node:crypto'
import { releaseMaterialPath } from './release-path.js'
import { isPrerelease, isSemVer } from './version.js'

export const RELEASE_TARGETS = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-arm64',
  'bun-linux-x64', 'bun-windows-arm64', 'bun-windows-x64'] as const
export type ReleaseTarget = typeof RELEASE_TARGETS[number]
export type ReleaseChannel = 'stable' | 'beta'
export interface ReleaseMaterial { path: string; bytes: number; sha256: string }
export interface ReleaseArtifact {
  target: ReleaseTarget
  filename: string
  bytes: number
  sha256: string
  runtime_sha256: string
  launcher_sha256: string
  materials: ReleaseMaterial[]
}
export interface ReleaseInventory {
  schema: 1
  version: string
  source_revision: string
  store_schema: number
  launcher_schema: number
  artifacts: ReleaseArtifact[]
}
export interface SeenChannel { sequence: number; digest: string }
export interface ChannelRecord {
  schema: 1
  channel: ReleaseChannel
  sequence: number
  version: string
  inventory_sha256: string
  withdrawn_versions: string[]
}
export interface ResolvedRelease {
  channel: ReleaseChannel
  seen: SeenChannel
  inventory: ReleaseInventory
  /** Retained with the immutable version for verification during rollback. */
  signedInventory: string
  signedChannel: string
  artifact: ReleaseArtifact
}
export type ExactRelease = Pick<ResolvedRelease, 'inventory' | 'signedInventory' | 'artifact'>

const REPOSITORY = 'Raidiant-io/notifai'
const MAX_METADATA = 256 * 1024
const MAX_ARTIFACT = 256 * 1024 * 1024
const origins = new Set(['https://github.com', 'https://raw.githubusercontent.com',
  'https://release-assets.githubusercontent.com'])
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function version(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && isSemVer(value)
}
function releaseUrl(release: string, file: string): string {
  if (!version(release)) throw new Error('Invalid release version')
  return `https://github.com/${REPOSITORY}/releases/download/v${release}/${file}`
}

/** Domain separation prevents a signed channel from being used as an inventory. */
export function releaseSigningMessage(kind: 'channel' | 'inventory', payload: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`notifai-release-v1\n${kind}\n`), payload])
}

/** Release data only. No activation, shell commands, account data or config URLs. */
export class Distribution {
  constructor(private readonly trustedKeys: Readonly<Record<string, string>>,
    private readonly fetcher: typeof fetch = fetch) {}

  private verifyRecord(kind: 'channel' | 'inventory', bytes: string): Record<string, unknown> {
    if (Buffer.byteLength(bytes) > MAX_METADATA) throw new Error('Release metadata exceeds its size limit')
    const envelope: unknown = JSON.parse(bytes)
    if (!record(envelope) || typeof envelope['key_id'] !== 'string' ||
      typeof envelope['payload'] !== 'string' || typeof envelope['signature'] !== 'string') {
      throw new Error('Malformed signed release record')
    }
    const key = Object.hasOwn(this.trustedKeys, envelope['key_id']) ? this.trustedKeys[envelope['key_id']] : undefined
    if (key === undefined) throw new Error('Release signing key is not trusted by this installer')
    const payload = Buffer.from(envelope['payload'], 'base64')
    const signature = Buffer.from(envelope['signature'], 'base64')
    if (payload.toString('base64') !== envelope['payload'] || signature.toString('base64') !== envelope['signature']) {
      throw new Error('Malformed release signature encoding')
    }
    const publicKey = createPublicKey(key)
    if (publicKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64 ||
      !verify(null, releaseSigningMessage(kind, payload), publicKey, signature)) throw new Error('Invalid release signature')
    const value: unknown = JSON.parse(payload.toString('utf8'))
    if (!record(value) || value['schema'] !== 1) throw new Error('Unsupported release record schema')
    return value
  }

  verifyInventory(bytes: string): ReleaseInventory {
    const value = this.verifyRecord('inventory', bytes)
    if (!version(value['version']) || typeof value['source_revision'] !== 'string' ||
      !/^[a-f0-9]{40}$/.test(value['source_revision']) || !positive(value['store_schema']) ||
      !positive(value['launcher_schema']) || !Array.isArray(value['artifacts']) ||
      value['artifacts'].length === 0 || value['artifacts'].length > RELEASE_TARGETS.length) {
      throw new Error('Malformed release inventory')
    }
    const targets = new Set<string>()
    for (const item of value['artifacts']) {
      if (!record(item) || !RELEASE_TARGETS.includes(item['target'] as ReleaseTarget) ||
        typeof item['target'] !== 'string' || targets.has(item['target']) ||
        !positive(item['bytes']) || item['bytes'] > MAX_ARTIFACT || !digest(item['sha256']) ||
        !digest(item['runtime_sha256']) || !digest(item['launcher_sha256'])) throw new Error('Invalid release target or artifact')
      const suffix = item['target'].startsWith('bun-windows-') ? 'zip' : 'tar.gz'
      if (item['filename'] !== `notifai-${value['version']}-${item['target'].slice(4)}.${suffix}`) {
        throw new Error('Invalid artifact filename')
      }
      if (!Array.isArray(item['materials']) || item['materials'].length > 128) throw new Error('Invalid release materials')
      const materialNames = new Set<string>()
      for (const material of item['materials']) {
        if (!record(material) || !releaseMaterialPath(material['path']) ||
            /^(notifai(?:-runtime)?(?:\.exe)?|inventory\.json)(?:\/|$)/i.test(material['path']) ||
            materialNames.has(material['path'].toLowerCase()) || !Number.isSafeInteger(material['bytes']) ||
            (material['bytes'] as number) < 0 || (material['bytes'] as number) > 128 * 1024 * 1024 ||
            !digest(material['sha256'])) throw new Error('Invalid release material')
        const normalized = material['path'].toLowerCase()
        if ([...materialNames].some(name => normalized.startsWith(`${name}/`) || name.startsWith(`${normalized}/`))) throw new Error('Conflicting release material paths')
        materialNames.add(normalized)
        Object.freeze(material)
      }
      Object.freeze(item['materials'])
      targets.add(item['target'])
      Object.freeze(item)
    }
    Object.freeze(value['artifacts'])
    return Object.freeze(value) as unknown as ReleaseInventory
  }

  verifyChannel(bytes: string, channel: ReleaseChannel, seen?: SeenChannel): ChannelRecord {
    const value = this.verifyRecord('channel', bytes)
    if (value['channel'] !== channel || !positive(value['sequence']) || !version(value['version']) ||
      !digest(value['inventory_sha256']) || !Array.isArray(value['withdrawn_versions']) ||
      value['withdrawn_versions'].length > 1000 || !value['withdrawn_versions'].every(version)) {
      throw new Error('Malformed release channel')
    }
    if (channel === 'stable' && isPrerelease(value['version'])) throw new Error('Prerelease cannot enter the stable channel')
    if (seen && (value['sequence'] < seen.sequence ||
      (value['sequence'] === seen.sequence && sha256(bytes) !== seen.digest))) {
      throw new Error('Release channel sequence replay or substitution refused')
    }
    Object.freeze(value['withdrawn_versions'])
    return Object.freeze(value) as unknown as ChannelRecord
  }

  async resolveRelease(options: { channel: ReleaseChannel; target: ReleaseTarget;
    version?: string; seen?: SeenChannel; acceptChannel?: (bytes: string) => void }): Promise<ResolvedRelease> {
    if (!['stable', 'beta'].includes(options.channel)) throw new Error('Unknown release channel')
    if (!RELEASE_TARGETS.includes(options.target)) throw new Error('Unsupported release target')
    const bytes = (await this.download(`https://raw.githubusercontent.com/${REPOSITORY}/release-metadata/${options.channel}.json`, MAX_METADATA)).toString('utf8')
    const channel = this.verifyChannel(bytes, options.channel, options.seen)
    options.acceptChannel?.(bytes)
    const selected = options.version ?? channel.version
    if (!version(selected)) throw new Error('Invalid exact release version')
    if (options.channel === 'stable' && isPrerelease(selected)) throw new Error('Prerelease cannot enter the stable channel')
    if (channel.withdrawn_versions.includes(selected)) throw new Error('This release has been withdrawn')
    const signedInventory = (await this.download(releaseUrl(selected, 'inventory.json'), MAX_METADATA)).toString('utf8')
    if (selected === channel.version && sha256(signedInventory) !== channel.inventory_sha256) {
      throw new Error('Release inventory integrity mismatch')
    }
    const inventory = this.verifyInventory(signedInventory)
    if (inventory.version !== selected) throw new Error('Release inventory version mismatch')
    const artifact = inventory.artifacts.find(item => item.target === options.target)
    if (!artifact) throw new Error('Release does not contain the requested target')
    return Object.freeze({ channel: options.channel,
      seen: Object.freeze({ sequence: channel.sequence, digest: sha256(bytes) }), inventory, signedInventory, signedChannel: bytes, artifact })
  }

  verifyArtifact(artifact: ReleaseArtifact, bytes: Uint8Array): void {
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error('Release artifact integrity mismatch')
  }

  /** Acquire the release carried by an adapter without consulting mutable
   * channel pointers. Its signature, version and source are all mandatory. */
  resolveExactRelease(options: { signedInventory: string; version: string;
    sourceRevision: string; target: ReleaseTarget }): ExactRelease {
    const inventory = this.verifyInventory(options.signedInventory)
    if (inventory.version !== options.version || inventory.source_revision !== options.sourceRevision) {
      throw new Error('Exact native release identity mismatch')
    }
    const artifact = inventory.artifacts.find(item => item.target === options.target)
    if (!artifact) throw new Error('Release does not contain the requested target')
    return Object.freeze({ inventory, signedInventory: options.signedInventory, artifact })
  }

  async downloadArtifact(release: ExactRelease): Promise<Buffer> {
    const bytes = await this.download(releaseUrl(release.inventory.version, release.artifact.filename), release.artifact.bytes)
    this.verifyArtifact(release.artifact, bytes)
    return bytes
  }

  private async download(address: string, limit: number): Promise<Buffer> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      for (let redirects = 0; redirects <= 4; redirects++) {
        const url = new URL(address)
        if (!origins.has(url.origin) || url.username || url.password) throw new Error('Untrusted release download origin')
        const response = await this.fetcher(url.href, { redirect: 'manual', signal: controller.signal, cache: 'no-store' })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel()
          const location = response.headers.get('location')
          if (!location) throw new Error('Release redirect has no destination')
          address = new URL(location, url).href
          continue
        }
        if (!response.ok || response.body === null) {
          await response.body?.cancel()
          throw new Error(`Release download failed (HTTP ${response.status})`)
        }
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let length = 0
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            length += chunk.value.byteLength
            if (length > limit) throw new Error('Release download exceeds its size limit')
            chunks.push(chunk.value)
          }
        } finally { await reader.cancel(); reader.releaseLock() }
        return Buffer.concat(chunks, length)
      }
      throw new Error('Too many release download redirects')
    } finally { clearTimeout(timer) }
  }
}
