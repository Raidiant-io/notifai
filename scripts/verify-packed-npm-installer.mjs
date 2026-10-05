#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertPackedTarballs } from './check-packed-boundary.mjs'
import { commandInvocation, repositoryRoot } from './cross-platform.mjs'
import { requireStatus, runExternal } from './run-external.mjs'

const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-packed-bootstrap-'))
const run = (command, args, phase, timeoutMs = 120_000) => {
  const invocation = commandInvocation(command, args)
  return requireStatus(runExternal(invocation.file, invocation.args, { cwd: repositoryRoot, env: process.env,
    phase, timeoutMs, ...invocation.options }))
}
try {
  const packed = path.join(root, 'packed'), installed = path.join(root, 'installed')
  mkdirSync(packed); mkdirSync(installed)
  const supplied = process.argv[2]
  if (!supplied) run('pnpm', ['--filter', '@raidiant/notifai-install', 'pack', '--pack-destination', packed], 'pack npm bootstrap')
  const files = supplied ? [path.resolve(supplied)] : readdirSync(packed).filter(name => name.endsWith('.tgz')).map(name => path.join(packed, name))
  assert.equal(files.length, 1, 'Exactly one npm bootstrap artifact is required')
  assertPackedTarballs({ tarballs: files })
  const userconfig = path.join(root, 'npmrc'); writeFileSync(userconfig, '', { mode: 0o600 })
  run('npm', ['install', '--prefix', installed, '--userconfig', userconfig, '--registry=https://registry.npmjs.org',
    '--ignore-scripts', '--no-audit', '--no-fund', files[0]], 'install exact npm bootstrap artifact')
  const packageRoot = path.join(installed, 'node_modules/@raidiant/notifai-install')
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@raidiant/notifai-install')
  assert.deepEqual(manifest.bin, { 'notifai-install': 'dist/main.mjs' })
  for (const name of ['preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts?.[name], undefined, 'Bootstrap cannot run automatically during npm installation')
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@zip.js/zip.js', 'tar-stream'])
  const source = path.join(repositoryRoot, 'packages/installer')
  const current = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'))
  // pnpm pack removes the source-only prepack hook from the published manifest.
  delete current.scripts.prepack
  assert.deepEqual(manifest, current, 'Packed bootstrap manifest differs from the reviewed source')
  const compare = (relative = 'dist') => {
    const expected = readdirSync(path.join(source, relative), { withFileTypes: true })
    assert.deepEqual(readdirSync(path.join(packageRoot, relative)).sort(), expected.map(entry => entry.name).sort(), 'Packed bootstrap file inventory differs')
    for (const entry of expected) {
      const file = path.join(relative, entry.name)
      if (entry.isDirectory()) compare(file)
      else assert.deepEqual(readFileSync(path.join(packageRoot, file)), readFileSync(path.join(source, file)), 'Packed bootstrap content differs')
    }
  }
  compare()
  const launcher = path.join(packageRoot, 'dist/main.mjs')
  const help = run(process.execPath, [launcher, '--help'], 'start installed npm bootstrap', 10_000)
  assert.match(help.stdout, /Later runtime updates use notifai update/)
  const result = runExternal(process.execPath, [launcher, '--json', '--version', 'not-a-version'], {
    cwd: installed, env: process.env, phase: 'reject invalid bootstrap version', timeoutMs: 10_000 })
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stdout).code, 'bootstrap_failed')
  console.log(JSON.stringify({ ok: true, package: manifest.name, version: manifest.version,
    checks: ['packed-boundary', 'exact-source-bytes', 'isolated-registry-dependencies', 'no-install-lifecycle', 'separate-bin-name', 'startup-help', 'bounded-json-failure'] }))
} finally { rmSync(root, { recursive: true, force: true }) }
