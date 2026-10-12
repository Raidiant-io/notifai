import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'
import { Readable, Transform, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { extract } from 'tar-stream'
import { Uint8ArrayReader, ZipReader } from '@zip.js/zip.js'
import { ensurePrivateDirectory } from './atomic-file.js'
import type { Distribution, ReleaseArtifact, ReleaseTarget } from './release-distribution.js'
import { releaseMaterialPath } from './release-path.js'

const MAX_EXPANDED = 768 * 1024 * 1024
const MAX_FILE = 512 * 1024 * 1024
const MAX_ENTRIES = 130
interface Entry { name: string; size: number }
type Consume = (entry: Entry, chunks: AsyncIterable<Uint8Array>) => Promise<void>

/** Reads untrusted tar data without writing paths. Tar metadata is normalized by
 * tar-stream; callers must not forward these source bytes to a different parser
 * unless the compressed archive itself has independent release authority. */
export async function tarEntries(bytes: Uint8Array, consume: Consume, maxExpanded = MAX_EXPANDED): Promise<void> {
  const reader = extract()
  let expanded = 0
  const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
    expanded += chunk.length
    done(expanded > maxExpanded ? new Error('Archive expanded size exceeds its limit') : null, chunk)
  } })
  const pumping = pipeline(Readable.from([bytes]), createGunzip(), limit, reader as unknown as Writable,
    { signal: AbortSignal.timeout(120_000) })
  // Register rejection immediately while the async iterator consumes entries.
  void pumping.catch(() => undefined)
  try {
    for await (const stream of reader) {
      const header = stream.header
      if (header.type !== 'file' || header.linkname) throw new Error('Archive contains a non-regular entry')
      await consume({ name: header.name, size: header.size }, stream as AsyncIterable<Uint8Array>)
    }
    await pumping
  } catch (error) { reader.destroy(error as Error); await pumping.catch(() => undefined); throw error }
}

async function zipEntries(bytes: Uint8Array, consume: Consume): Promise<void> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { strictness: 'strict',
    useWebWorkers: false, useCompressionStream: true })
  try {
    let count = 0
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > MAX_ENTRIES) throw new Error('Archive entry count exceeds its limit')
      const unixType = (entry.externalFileAttributes >>> 16) & 0o170000
      if (entry.directory || entry.symlink || entry.encrypted || !entry.getData || (unixType !== 0 && unixType !== 0o100000)) throw new Error('Archive contains a non-regular entry')
      // The bounded consumer reads a Web stream; zip.js never writes a path.
      const stream = new TransformStream<Uint8Array, Uint8Array>()
      const output = entry.getData(stream.writable, { checkSignature: true, strictness: 'strict',
        signal: AbortSignal.timeout(120_000) })
      void output.catch(() => undefined)
      const input = stream.readable.getReader()
      try {
        await consume({ name: entry.filename, size: entry.uncompressedSize }, {
          async *[Symbol.asyncIterator]() {
            for (;;) { const chunk = await input.read(); if (chunk.done) break; yield chunk.value }
          },
        })
        await output
      } catch (error) { await input.cancel(error); await output.catch(() => undefined); throw error }
      finally { input.releaseLock() }
    }
  } finally { await reader.close() }
}

function inventoryFiles(artifact: ReleaseArtifact): Map<string, { bytes?: number; sha256: string }> {
  const extension = artifact.target.startsWith('bun-windows-') ? '.exe' : ''
  return new Map<string, { bytes?: number; sha256: string }>([
    [`notifai${extension}`, { sha256: artifact.launcher_sha256 }],
    [`notifai-runtime${extension}`, { sha256: artifact.runtime_sha256 }],
    ...artifact.materials.map(item => [item.path, { bytes: item.bytes, sha256: item.sha256 }] as const),
  ])
}

/** Authenticate the compressed bytes and preflight every entry before creating
 * any extracted file. The second pass writes only into a new private directory.
 * Caller owns removal of the returned directory after staging or failure. */
export async function extractReleaseArchive(input: { distribution: Distribution; signedInventory: string;
  target: ReleaseTarget; bytes: Uint8Array; parent: string }): Promise<string> {
  const inventory = input.distribution.verifyInventory(input.signedInventory)
  const artifact = inventory.artifacts.find(item => item.target === input.target)
  if (!artifact) throw new Error('Release does not contain this target')
  input.distribution.verifyArtifact(artifact, input.bytes)
  const expected = inventoryFiles(artifact)
  const parse = input.target.startsWith('bun-windows-') ? zipEntries : tarEntries
  const pass = async (directory?: string) => {
    const seen = new Set<string>()
    let total = 0
    await parse(input.bytes, async (entry, chunks) => {
      const wanted = expected.get(entry.name)
      if (!releaseMaterialPath(entry.name) || seen.has(entry.name.toLowerCase()) || !wanted ||
          seen.size >= MAX_ENTRIES || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE ||
          (wanted.bytes !== undefined && entry.size !== wanted.bytes)) throw new Error('Archive entry is not admitted by the signed inventory')
      seen.add(entry.name.toLowerCase())
      if ((total += entry.size) > MAX_EXPANDED) throw new Error('Archive expanded size exceeds its limit')
      let file: number | undefined
      if (directory) {
        const destination = path.join(directory, entry.name)
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
        file = openSync(destination, 'wx', entry.name === 'notifai' || entry.name === 'notifai-runtime' ? 0o700 : 0o600)
      }
      const digest = createHash('sha256')
      let actual = 0
      try {
        for await (const chunk of chunks) {
          if ((actual += chunk.byteLength) > entry.size) throw new Error('Archive entry exceeds its declared size')
          digest.update(chunk)
          if (file !== undefined) {
            let offset = 0
            while (offset < chunk.byteLength) offset += writeSync(file, chunk, offset, chunk.byteLength - offset)
          }
        }
        if (actual !== entry.size || digest.digest('hex') !== wanted.sha256) throw new Error('Archive entry integrity mismatch')
      } finally { if (file !== undefined) closeSync(file) }
    })
    if (seen.size !== expected.size) throw new Error('Archive is missing required release files')
  }
  await pass()
  ensurePrivateDirectory(input.parent)
  const directory = mkdtempSync(path.join(input.parent, 'release-'))
  try { await pass(directory); return directory }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}
