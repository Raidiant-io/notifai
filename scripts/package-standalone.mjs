#!/usr/bin/env node
// Packages checked bytes. This does not sign, publish, or certify license material.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'
import { repositoryRoot } from './cross-platform.mjs'
import { RELEASE_TARGETS } from '../apps/cli/dist/release-distribution.js'
import { releaseMaterialPath } from '../apps/cli/dist/release-path.js'
import { isSemVer } from '../apps/cli/dist/version.js'

const dependency = createRequire(path.join(repositoryRoot, 'apps/cli/package.json'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function regular(file, limit = 512 * 1024 * 1024) {
  const stat = lstatSync(file)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'Input must be a bounded regular file')
  return readFileSync(file)
}
function materialsUnder(root, relative = '') {
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Material root must be a regular directory')
  return readdirSync(root).sort().flatMap(name => {
    const file = path.join(root, name), portable = relative ? `${relative}/${name}` : name
    assert.ok(releaseMaterialPath(portable), 'Unsafe material path')
    const stat = lstatSync(file)
    assert.ok(!stat.isSymbolicLink(), 'Linked material is not allowed')
    return stat.isDirectory() ? materialsUnder(file, portable) : [[portable, regular(file), false]]
  })
}

export async function packageStandalone({ directory, materials, output }) {
  // The receipt's target, not this packager's host, selects archive layout.
  const checkBytes = regular(path.join(directory, 'check.json'), 256 * 1024)
  const check = JSON.parse(checkBytes)
  assert.ok(['isolated-no-runtime-path', 'embedded-skill-integrity', 'process-identity', 'cwd-config', 'BUN_OPTIONS', 'BUN_BE_BUN']
    .every(name => Array.isArray(check.checks) && check.checks.includes(name)), 'Native executable checks are incomplete')
  const build = check.build
  assert.ok(check.ok === true && build && RELEASE_TARGETS.includes(build.target) && isSemVer(build.version))
  assert.ok(build.sourceDirty === false && /^[a-f0-9]{40}$/.test(build.sourceRevision) && /^[a-f0-9]{64}$/.test(build.sourceDigest))
  const extension = build.target.startsWith('bun-windows-') ? '.exe' : ''
  const runtimeFile = `notifai-runtime${extension}`, launcherFile = `notifai${extension}`
  const identity = JSON.parse(regular(path.join(directory, `${runtimeFile}.build.json`), 256 * 1024))
  assert.deepEqual(identity, build, 'Build and execution receipts disagree')
  const runtime = regular(path.join(directory, runtimeFile)), launcher = regular(path.join(directory, launcherFile))
  assert.equal(hash(runtime), check.runtime_sha256, 'Runtime changed after native checks')
  assert.equal(hash(launcher), check.launcher_sha256, 'Launcher changed after native checks')
  const materialEntries = materialsUnder(materials)
  assert.ok(materialEntries.length > 0 && materialEntries.length <= 128, 'A bounded material inventory is required')
  const names = new Set()
  for (const [name] of materialEntries) {
    const key = name.toLowerCase()
    assert.ok(!/^(notifai(?:-runtime)?(?:\.exe)?|inventory\.json)(?:\/|$)/i.test(name) && !names.has(key), 'Material collides with a reserved path')
    for (const existing of names) assert.ok(!existing.startsWith(`${key}/`) && !key.startsWith(`${existing}/`), 'Material path prefix collision')
    names.add(key)
  }
  const entries = [[launcherFile, launcher, true], [runtimeFile, runtime, true], ...materialEntries]
  assert.ok(entries.reduce((size, [, bytes]) => size + bytes.length, 0) <= 768 * 1024 * 1024, 'Expanded archive exceeds its limit')
  let archive
  if (extension) {
    const { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } = dependency('@zip.js/zip.js')
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true,
      lastModDate: new Date(1980, 0, 1), rawLastModDate: 0x00210000, extendedTimestamp: false, msDosCompatible: false, versionMadeBy: 3 << 8 })
    for (const [name, bytes, executable] of entries) await writer.add(name, new Uint8ArrayReader(bytes), {
      externalFileAttributes: ((executable ? 0o100755 : 0o100644) << 16) >>> 0,
    })
    archive = Buffer.from(await writer.close())
  } else {
    const writer = dependency('tar-stream').pack(), chunks = []
    const consumed = (async () => { for await (const chunk of writer) chunks.push(chunk) })()
    for (const [name, bytes, executable] of entries) await new Promise((resolve, reject) => {
      writer.entry({ name, type: 'file', size: bytes.length, mode: executable ? 0o755 : 0o644,
        uid: 0, gid: 0, mtime: new Date(0) }, bytes, error => error ? reject(error) : resolve())
    })
    writer.finalize(); await consumed
    archive = gzipSync(Buffer.concat(chunks))
  }
  assert.ok(archive.length <= 256 * 1024 * 1024, 'Compressed archive exceeds its limit')
  const artifact = { target: build.target, filename: `notifai-${build.version}-${build.target.slice(4)}.${extension ? 'zip' : 'tar.gz'}`,
    bytes: archive.length, sha256: hash(archive), runtime_sha256: hash(runtime), launcher_sha256: hash(launcher),
    materials: materialEntries.map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })) }
  const metadata = { schema: 1, build, artifact, check_sha256: hash(checkBytes) }
  mkdirSync(output) // Exclusive destination; never replace a previous candidate.
  try {
    writeFileSync(path.join(output, artifact.filename), archive, { flag: 'wx', mode: 0o600 })
    writeFileSync(path.join(output, 'artifact.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error }
  return metadata
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, materials: { type: 'string' }, output: { type: 'string' } } })
  assert.ok(values.directory && values.materials && values.output, '--directory, --materials, and --output are required')
  await packageStandalone(values)
}
