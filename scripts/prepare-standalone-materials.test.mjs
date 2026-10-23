import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { prepareMaterials } from './prepare-standalone-materials.mjs'

test('prepares the pinned license offline and retains its provenance', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'materials-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network is forbidden') })
  const output = path.join(root, 'output')
  prepareMaterials(output)
  const source = JSON.parse(readFileSync(path.join(output, 'sources/bun.json')))
  const license = readFileSync(path.join(output, 'licenses/bun-LICENSE.md'))
  assert.equal(createHash('sha256').update(license).digest('hex'), source.license_sha256)
  assert.match(source.license_url, /744846f844374847c902b5e7fd59b4342a51ef99/)
})
test('refuses changed vendored bytes before creating output', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'materials-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'distribution'))
  writeFileSync(path.join(root, 'distribution/bun-LICENSE.md'), 'changed')
  assert.throws(() => prepareMaterials(path.join(root, 'output'), root), /digest differs/)
})
