import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installationAccess } from './installation-access.js'
import { LEGACY_NPM_RELEASES } from './legacy-npm-releases.js'
import { inspectLegacyNpmPackage, snapshotLegacyNpmPackage } from './legacy-npm-package.js'
import { npmShim } from './npm-adapter-route.js'

vi.mock('./legacy-npm-releases.js', () => ({ LEGACY_NPM_RELEASES: {} }))
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
describe('exact legacy package assessment and preservation', () => {
  let root: string, prefix: string, directory: string
  const access = vi.fn()
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'notifai-legacy-package-')))
    prefix = path.join(root, 'prefix'); directory = path.join(prefix, 'node_modules/@raidiant/notifai')
    mkdirSync(path.join(directory, 'dist'), { recursive: true })
    const files = new Map([
      ['dist/main.js', '#!/usr/bin/env node\nimport("./main-run.js")\n'],
      ['dist/main-run.js', 'export {}\n'],
      ['package.json', JSON.stringify({ name: '@raidiant/notifai', version: '11.7.1', bin: { notifai: 'dist/main.js' } })],
    ])
    for (const [name, bytes] of files) writeFileSync(path.join(directory, name), bytes)
    const inventory = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, bytes]) => [name, Buffer.byteLength(bytes), hash(bytes)])
    ;(LEGACY_NPM_RELEASES as Record<string, { files: number; sha256: string }>)['11.7.1'] = {
      files: files.size, sha256: hash(JSON.stringify(inventory)),
    }
    for (const extension of ['', '.cmd', '.ps1']) writeFileSync(path.join(prefix, `notifai${extension}`),
      npmShim('node_modules/@raidiant/notifai/dist/main.js', extension).replaceAll('\n', '\r\n'))
    access.mockClear()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  it('recognizes exact released files and all three shims while leaving custom dependency bytes unverified', () => {
    mkdirSync(path.join(directory, 'node_modules/custom'), { recursive: true })
    writeFileSync(path.join(directory, 'node_modules/custom/local-edit.js'), 'user customization')
    const proof = inspectLegacyNpmPackage(prefix, access)
    expect(proof.version).toBe('11.7.1')
    expect(proof.dependency_files).toBe(1)
    expect(proof.files).toHaveLength(4)
    expect(proof.shims).toHaveLength(3)
    expect(access.mock.calls.flatMap(call => call[0])).toEqual(expect.arrayContaining([
      { file: path.join(directory, 'node_modules/custom/local-edit.js'), directory: false },
    ]))
  })
  for (const change of ['published edit', 'extra file', 'extra directory', 'modified shim', 'unknown release']) {
    it(`preserves and refuses ${change}`, () => {
      if (change === 'published edit') writeFileSync(path.join(directory, 'dist/main-run.js'), 'local edit')
      if (change === 'extra file') writeFileSync(path.join(directory, 'custom.txt'), 'local file')
      if (change === 'extra directory') mkdirSync(path.join(directory, 'custom'))
      if (change === 'modified shim') writeFileSync(path.join(prefix, 'notifai.cmd'), `${readFileSync(path.join(prefix, 'notifai.cmd'), 'utf8')}echo extra\n`)
      if (change === 'unknown release') writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@raidiant/notifai', version: '0.0.1', bin: { notifai: 'dist/main.js' } }))
      expect(() => inspectLegacyNpmPackage(prefix, access)).toThrow(/unchanged|modified/)
      expect(existsSync(directory)).toBe(true)
    })
  }
  it('refuses unowned paths and linked dependencies', () => {
    expect(() => inspectLegacyNpmPackage(prefix, () => { throw new Error('foreign owner') })).toThrow('foreign owner')
    mkdirSync(path.join(directory, 'node_modules'))
    symlinkSync(root, path.join(directory, 'node_modules/escape'), 'junction')
    expect(() => inspectLegacyNpmPackage(prefix, access)).toThrow(/linked/)
  })
  // This validates snapshot behavior using this host's real private-directory
  // policy. Native Windows ACL acceptance is exercised by the hosted lane.
  it.skipIf(process.platform === 'win32')('preserves every dependency and original shim and refuses later file edits', () => {
    mkdirSync(path.join(directory, 'node_modules/custom'), { recursive: true })
    writeFileSync(path.join(directory, 'node_modules/custom/local-edit.js'), 'keep this exact edit')
    const proof = inspectLegacyNpmPackage(prefix, access), destination = path.join(root, 'snapshot')
    const digest = snapshotLegacyNpmPackage(proof, destination, installationAccess())
    expect(hash(readFileSync(path.join(destination, 'snapshot.json')))).toBe(digest)
    for (const file of proof.files) expect(readFileSync(path.join(destination, 'package', file.path))).toEqual(readFileSync(path.join(directory, file.path)))
    for (const file of proof.shims) expect(readFileSync(path.join(destination, 'shims', file.path))).toEqual(readFileSync(path.join(prefix, file.path)))
    expect(() => snapshotLegacyNpmPackage(proof, destination, installationAccess())).toThrow(/already exists/)
    expect(() => snapshotLegacyNpmPackage(proof, path.join(prefix, 'backup'), installationAccess())).toThrow(/outside/)
    writeFileSync(path.join(directory, 'node_modules/custom/local-edit.js'), 'a later edit')
    const changed = path.join(root, 'changed-snapshot')
    expect(() => snapshotLegacyNpmPackage(proof, changed, installationAccess())).toThrow(/match/)
    expect(existsSync(changed)).toBe(false)
    expect(readFileSync(path.join(directory, 'node_modules/custom/local-edit.js'), 'utf8')).toBe('a later edit')
  })
})
