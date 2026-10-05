import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { afterEach, expect, it } from 'vitest'
import { extractReleaseArchive } from './release-archive.js'
import { Distribution, releaseSigningMessage } from './release-distribution.js'
import { ensurePrivateDirectory } from './atomic-file.js'
import { Installation } from './installation.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const distribution = new Distribution({ fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() })
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
async function fixture(zip: boolean, fault?: 'extra' | 'missing' | 'tampered' | 'traversal' | 'symlink') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-archive-')); roots.push(root)
  const extension = zip ? '.exe' : ''
  const entries: [string, string][] = [[`notifai${extension}`, 'launcher'], [`notifai-runtime${extension}`, 'runtime'],
    ['licenses/NOTICE.txt', 'Keep this notice']]
  const target = zip ? 'bun-windows-x64' as const : 'bun-linux-x64' as const
  if (fault === 'extra') entries.push(['unexpected', 'surprise'])
  if (fault === 'traversal') entries.push(['../escape', 'surprise'])
  if (fault === 'missing') entries.pop()
  if (fault === 'tampered') entries[2]![1] = 'Changed notice'
  let bytes: Uint8Array
  if (zip) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true })
    for (const [name, contents] of entries) await writer.add(name, new Uint8ArrayReader(Buffer.from(contents)))
    bytes = await writer.close()
  } else {
    const writer = pack(), chunks: Uint8Array[] = []
    const output = (async () => { for await (const chunk of writer) chunks.push(chunk as Uint8Array) })()
    for (const [name, contents] of entries) writer.entry({ name }, contents)
    if (fault === 'symlink') writer.entry({ name: 'linked', type: 'symlink', linkname: '../elsewhere' })
    writer.finalize(); await output
    bytes = gzipSync(Buffer.concat(chunks))
  }
  const payload = Buffer.from(JSON.stringify({ schema: 1, version: '1.0.0', source_revision: 'a'.repeat(40),
    store_schema: 1, launcher_schema: 1, artifacts: [{ target, filename: `notifai-1.0.0-${target.slice(4)}.${zip ? 'zip' : 'tar.gz'}`,
      bytes: bytes.length, sha256: hash(bytes), runtime_sha256: hash('runtime'), launcher_sha256: hash('launcher'),
      materials: [{ path: 'licenses/NOTICE.txt', bytes: 16, sha256: hash('Keep this notice') }] }] }))
  const signedInventory = JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
    signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') })
  return { distribution, signedInventory, target, bytes, parent: path.join(root, 'extract'), root }
}

it.each([false, true])('authenticates and retains every release material (zip=%s)', async zip => {
  const input = await fixture(zip), directory = await extractReleaseArchive(input)
  expect(readFileSync(path.join(directory, 'licenses/NOTICE.txt'), 'utf8')).toBe('Keep this notice')
  const install = new Installation({ root: path.join(input.root, 'managed'), target: input.target, distribution, access: { check() {}, directory: ensurePrivateDirectory, beforePublish() {} }, probe() {} })
  const build = install.stage({ directory, signedInventory: input.signedInventory })
  expect(readFileSync(path.join(input.root, 'managed/versions', build, 'licenses/NOTICE.txt'), 'utf8')).toBe('Keep this notice')
  expect(readdirSync(input.parent)).toHaveLength(1)
})

it.each([false, true])('rejects malformed signed archives before writing anything (zip=%s)', async zip => {
  for (const fault of ['extra', 'missing', 'tampered', 'traversal'] as const) {
    const input = await fixture(zip, fault)
    await expect(extractReleaseArchive(input)).rejects.toThrow()
    expect(existsSync(input.parent)).toBe(false)
    expect(existsSync(path.join(input.root, 'escape'))).toBe(false)
  }
  const input = await fixture(zip)
  input.bytes[0] = input.bytes[0]! ^ 1
  await expect(extractReleaseArchive(input)).rejects.toThrow(/integrity/)
  expect(existsSync(input.parent)).toBe(false)
})

it('refuses tar symlinks before creating extraction output', async () => {
  const input = await fixture(false, 'symlink')
  await expect(extractReleaseArchive(input)).rejects.toThrow(/non-regular/)
  expect(existsSync(input.parent)).toBe(false)
})
