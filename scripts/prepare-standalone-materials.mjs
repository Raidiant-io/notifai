#!/usr/bin/env node
// Candidate notices only. Complete runtime notices/source/relink review gates publication.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { repositoryRoot } from './cross-platform.mjs'

const source = { runtime: 'bun-1.4.2', revision: '744846f844374847c902b5e7fd59b4342a51ef99',
  license_url: 'https://raw.githubusercontent.com/oven-sh/bun/744846f844374847c902b5e7fd59b4342a51ef99/LICENSE.md',
  license_sha256: 'b9caf52728691b4057e371232c221a132883198be2f3d2ddf92c90404c984b1a' }
export function prepareMaterials(output, repo = repositoryRoot) {
const license = readFileSync(path.join(repo, 'distribution/bun-LICENSE.md'))
assert.ok(license.length <= 8192, 'Pinned material exceeds its size limit')
assert.equal(createHash('sha256').update(license).digest('hex'), source.license_sha256, 'Pinned Bun material digest differs')
mkdirSync(output)
mkdirSync(path.join(output, 'licenses'))
mkdirSync(path.join(output, 'sources'))
writeFileSync(path.join(output, 'licenses/notifai-LICENSE.txt'), readFileSync(path.join(repo, 'LICENSE')), { flag: 'wx' })
writeFileSync(path.join(output, 'licenses/bun-LICENSE.md'), license, { flag: 'wx' })
writeFileSync(path.join(output, 'sources/bun.json'), `${JSON.stringify(source, null, 2)}\n`, { flag: 'wx' })
writeFileSync(path.join(output, 'CANDIDATE-MATERIALS.txt'),
  'Development candidate, not a production release. Complete third-party notices and the JavaScriptCore source/relink path have not been verified for publication.\n', { flag: 'wx' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, candidate: { type: 'boolean', default: false } } })
  assert.ok(values.output && values.candidate, 'Only --candidate --output <new-directory> is supported until publication materials are reviewed')
  prepareMaterials(values.output)
}
