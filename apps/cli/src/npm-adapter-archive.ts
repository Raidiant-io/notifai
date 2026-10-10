import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { tarEntries } from './release-archive.js'
import type { Distribution } from './release-distribution.js'
import { releaseMaterialPath } from './release-path.js'
import { NPM_ADAPTER_BIN, NPM_ADAPTER_INVENTORY, NPM_ADAPTER_MANIFEST,
  NPM_ADAPTER_MAX_BYTES, NPM_ADAPTER_MAX_METADATA, parseNpmAdapterManifest, assertNpmAdapterPackage } from './npm-adapter-contract.js'

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export interface NpmReplacementTarget { version: string; inventory_sha256: string; archive_sha256: string }

/** Authenticate only the selected release's files, then create a fresh archive.
 * npm never parses the untrusted source tar: different readers can interpret
 * PAX/GNU metadata differently. No registry tag or caller-supplied hash grants
 * authority. The existing signed native inventory authenticates the payload. */
export async function prepareNpmAdapterArchive(bytes: Uint8Array, signedInventory: string,
  distribution: Pick<Distribution, 'verifyInventory'>): Promise<{ bytes: Buffer; target: NpmReplacementTarget }> {
  const inventory = distribution.verifyInventory(signedInventory)
  if (bytes.byteLength > NPM_ADAPTER_MAX_BYTES) throw new Error('Npm archive exceeds its size limit')
  const files = new Map<string, Buffer>(), names = new Set<string>()
  let total = 0
  await tarEntries(bytes, async (entry, chunks) => {
    const name = entry.name.startsWith('package/') ? entry.name.slice(8) : ''
    const metadata = [NPM_ADAPTER_MANIFEST, NPM_ADAPTER_INVENTORY, 'package.json'].includes(name)
    if (!releaseMaterialPath(name) || names.has(name.toLowerCase()) || names.size >= 130 ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        entry.size > (metadata ? NPM_ADAPTER_MAX_METADATA : NPM_ADAPTER_MAX_BYTES) ||
        (total += entry.size) > NPM_ADAPTER_MAX_BYTES + 2 * NPM_ADAPTER_MAX_METADATA) {
      throw new Error('Npm archive contains an unrecognized or oversized entry')
    }
    names.add(name.toLowerCase())
    const buffers: Buffer[] = []
    let size = 0
    for await (const chunk of chunks) {
      if ((size += chunk.byteLength) > entry.size) throw new Error('Npm archive entry exceeds its declared size')
      buffers.push(Buffer.from(chunk))
    }
    if (size !== entry.size) throw new Error('Npm archive entry is incomplete')
    files.set(name, Buffer.concat(buffers))
  }, 2 * NPM_ADAPTER_MAX_BYTES)
  if (files.get(NPM_ADAPTER_INVENTORY)?.toString('utf8') !== signedInventory) {
    throw new Error('Npm archive is not the selected signed release')
  }
  const manifestBytes = files.get(NPM_ADAPTER_MANIFEST)
  if (!manifestBytes) throw new Error('Npm archive manifest is missing')
  const manifest = parseNpmAdapterManifest(manifestBytes.toString('utf8'))
  if (manifest.native.version !== inventory.version || manifest.native.source_revision !== inventory.source_revision ||
      !inventory.artifacts.every(artifact => artifact.materials.some(material => material.path === NPM_ADAPTER_MANIFEST &&
        material.bytes === manifestBytes.length && material.sha256 === hash(manifestBytes)))) {
    throw new Error('Npm archive manifest is not authenticated by the selected release')
  }
  if (files.size !== manifest.files.length + 2 || manifest.files.some(item => {
    const content = files.get(item.path)
    return !content || content.length !== item.bytes || hash(content) !== item.sha256
  })) throw new Error('Npm archive payload integrity mismatch')
  assertNpmAdapterPackage(JSON.parse(files.get('package.json')!.toString('utf8')), manifest)

  // Pack trusted entries with fixed metadata; discard every source header,
  // extension and trailing byte. Only npm owns installation and its shims.
  const writer = pack(), output: Buffer[] = []
  const collecting = (async () => { for await (const chunk of writer) output.push(Buffer.from(chunk as Uint8Array)) })()
  for (const [name, content] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    writer.entry({ name: `package/${name}`, type: 'file', mode: name === NPM_ADAPTER_BIN ? 0o755 : 0o644,
      uid: 0, gid: 0, mtime: new Date(0) }, content)
  }
  writer.finalize()
  await collecting
  const normalized = gzipSync(Buffer.concat(output))
  return { bytes: normalized, target: { version: inventory.version,
    inventory_sha256: hash(signedInventory), archive_sha256: hash(normalized) } }
}
