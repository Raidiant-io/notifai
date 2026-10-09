#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { repositoryRoot } from './cross-platform.mjs'
import { Distribution } from '../apps/cli/dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/cli/dist/release-trust.js'
import { NPM_ADAPTER_DIRECTORY } from '../apps/cli/dist/npm-adapter-contract.js'
import { adapterPackageManifest, bindAdapterInventory, generateAdapterManifest } from './npm-adapter-artifact.mjs'

export async function buildNpmAdapter({ sourceRevision, output = path.join(repositoryRoot, NPM_ADAPTER_DIRECTORY) }) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/, 'An exact source revision is required')
  output = path.resolve(output)
  assert.ok(output === path.join(repositoryRoot, NPM_ADAPTER_DIRECTORY) || !existsSync(output),
    'A custom artifact output must be a new directory; existing User files are preserved')
  if (existsSync(output)) assert.ok(lstatSync(output).isDirectory() && !lstatSync(output).isSymbolicLink(), 'Artifact output must be a regular directory')
  const source = JSON.parse(readFileSync(path.join(repositoryRoot, 'apps/cli/package.json'), 'utf8'))
  rmSync(output, { recursive: true, force: true })
  mkdirSync(path.join(output, 'bin'), { recursive: true })
  mkdirSync(path.join(output, 'data'))
  // Only canonical release verification/acquisition modules are reachable from
  // this entrypoint. esbuild includes their small archive dependency graph.
  const result = await build({ absWorkingDir: repositoryRoot, entryPoints: [path.join(repositoryRoot, 'apps/cli/npm/main.mjs')],
    outfile: path.join(output, 'bin/notifai.mjs'), bundle: true, platform: 'node', format: 'esm',
    target: 'node20.12', sourcemap: false, legalComments: 'inline', metafile: true,
    // Source tests consume the normal CLI build. Published adapter bytes must
    // instead compile canonical source, even if that developer dist is stale.
    plugins: [{ name: 'canonical-acquisition-source', setup(builder) {
      builder.onResolve({ filter: /^\.\.\/dist\/[a-z0-9-]+\.js$/ }, args => {
        if (args.resolveDir !== path.join(repositoryRoot, 'apps/cli/npm')) return
        const name = path.basename(args.path), typed = path.join(repositoryRoot, 'apps/cli/src', name.replace(/\.js$/, '.ts'))
        return { path: existsSync(typed) ? typed : path.join(repositoryRoot, 'apps/cli/src', name) }
      })
    } }],
    banner: { js: "import { createRequire as __notifaiCreateRequire } from 'node:module'; const require = __notifaiCreateRequire(import.meta.url);" } })
  writeFileSync(path.join(output, 'package.json'), JSON.stringify(adapterPackageManifest(source), null, 2) + '\n')
  writeFileSync(path.join(output, 'data/release.json'), JSON.stringify({ version: source.version, source_revision: sourceRevision }) + '\n')
  copyFileSync(path.join(repositoryRoot, 'scripts/install.ps1'), path.join(output, 'data/install.ps1'))
  for (const [from, to] of [['LICENSE', 'LICENSE'], ['NOTICE', 'NOTICE'], ['apps/cli/CHANGELOG.md', 'CHANGELOG.md']]) {
    copyFileSync(path.join(repositoryRoot, from), path.join(output, to))
  }
  const dependencies = new Set()
  for (const input of Object.keys(result.metafile.inputs)) {
    assert.ok(!/apps\/cli\/(?:src|dist)\/(?:main|program|commands-|session-|hook-)/.test(input), 'The npm artifact cannot bundle the full product runtime')
    if (!input.includes('node_modules/')) continue
    let directory = path.dirname(path.resolve(input))
    while (directory !== path.dirname(directory)) {
      try {
        const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
        if (manifest.name) { dependencies.add(directory); break }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      directory = path.dirname(directory)
    }
  }
  const notices = [...dependencies].map(directory => {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
    let license
    for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE-MIT.txt', 'license']) {
      try { license = readFileSync(path.join(directory, name), 'utf8'); break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    assert.ok(license, `Missing bundled license notice for ${manifest.name}`)
    return { name: manifest.name, text: `${manifest.name}@${manifest.version}\n${license.trim()}\n` }
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES'), notices.map(item => item.text).join('\n') + '\n' +
    readFileSync(path.join(repositoryRoot, 'apps/cli/npm/SHIM-NOTICE'), 'utf8'))
  chmodSync(path.join(output, 'bin/notifai.mjs'), 0o755)
  const manifest = generateAdapterManifest(output, source.version, sourceRevision)
  return { directory: output, manifest }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { 'source-revision': { type: 'string' }, inventory: { type: 'string' },
    output: { type: 'string' }, 'bind-only': { type: 'boolean' } } })
  const output = values.output ? path.resolve(values.output) : path.join(repositoryRoot, NPM_ADAPTER_DIRECTORY)
  if (!values['bind-only']) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
    const revision = values['source-revision'] ?? head
    assert.equal(revision, head, 'Adapter source revision must identify this checkout HEAD')
    await buildNpmAdapter({ sourceRevision: revision, output })
  }
  if (values.inventory) {
    const stat = lstatSync(values.inventory)
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024, 'Signed inventory must be a bounded regular file')
    bindAdapterInventory(output, readFileSync(values.inventory, 'utf8'), new Distribution(RELEASE_PUBLIC_KEYS))
  } else assert.ok(!values['bind-only'], '--bind-only requires --inventory')
  console.log(`Generated npm adapter at ${path.relative(repositoryRoot, output)}${values.inventory ? ' with signed native inventory' : ' (payload only; not publishable until native signing)'}`)
}
