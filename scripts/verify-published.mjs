#!/usr/bin/env node
/**
 * Compare what npm is serving against what this checkout builds.
 *
 * Every other gate here runs before publishing, which means all of them can
 * pass on a tree that is never the tree that ships. That gap is not
 * theoretical: a release once went out from a directory whose ignored `dist/`
 * belonged to the previous version, and it satisfied every pre-publish check,
 * reported the new version correctly, and was believed for a day.
 *
 * So this runs *after* publishing and asks the only question left: is the
 * package on the registry the one we meant to send? That is two comparisons,
 * because a package is two things: the compiled files, byte for byte, and the
 * manifest metadata npm resolves installs from. A release once shipped
 * matching compiled files whose published `dependencies` still named the
 * previous protocol version — every file compared clean while every clean
 * install crashed at startup. It reads npm and the local build, and needs no
 * credentials.
 *
 * Usage:
 *   node scripts/verify-published.mjs                # every publishable package
 *   node scripts/verify-published.mjs @raidiant/notifai
 *   node scripts/verify-published.mjs @raidiant/notifai --expected-tarball artifact.tgz
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {repositoryRoot} from './cross-platform.mjs'
import {lookupPublishedTarball} from './npm-registry.mjs'
import { expectedTarballFailure } from './tarball-integrity.mjs'

const root = repositoryRoot
const failures = []
const notes = []

const PACKAGES = [
  { name: '@raidiant/notifai', directory: 'apps/cli' },
  { name: '@raidiant/notifai-protocol', directory: 'packages/protocol' },
]

const requested = []
let expectedTarball
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]
  if (argument === '--expected-tarball') {
    expectedTarball = process.argv[index + 1]
    index += 1
    if (expectedTarball === undefined) failures.push('--expected-tarball requires a path')
  } else {
    requested.push(argument)
  }
}
if (expectedTarball !== undefined && requested.length !== 1) {
  failures.push('--expected-tarball requires exactly one package name')
}
const selected = requested.length === 0 ? PACKAGES : PACKAGES.filter((p) => requested.includes(p.name))
for (const name of requested) {
  if (!PACKAGES.some((p) => p.name === name)) failures.push(`unknown package ${name}`)
}

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex')
/**
 * Manifest fields where published/local skew changes what an install resolves
 * or executes. `dependencies` is the field that already shipped a startup
 * crash; the others are the same failure through a different door.
 */
const METADATA_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bin',
  'main',
  'types',
  'exports',
  'engines',
]

/** JSON with recursively sorted object keys, so key order never masquerades as a difference. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/** Every file under a directory, relative and sorted, so two trees compare. */
function treeFiles(directory) {
  const out = []
  const walk = (current) => {
    for (const child of readdirSync(current).sort()) {
      const full = path.join(current, child)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(path.relative(directory, full))
    }
  }
  try {
    walk(directory)
  } catch {
    return null
  }
  return out.sort()
}

for (const entry of selected) {
  const manifest = JSON.parse(readFileSync(path.join(root, entry.directory, 'package.json'), 'utf8'))
  const version = manifest.version
  const label = `${entry.name}@${version}`

  let tarballUrl
  try {
    tarballUrl = await lookupPublishedTarball(label)
  } catch (error) {
    failures.push(`${label}: not published, or npm view failed (${String(error)})`)
    continue
  }
  if (tarballUrl.length === 0) {
    failures.push(`${label}: npm reported no tarball for this version`)
    continue
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-verify-'))
  try {
    const response = await fetch(tarballUrl)
    if (!response.ok) {
      failures.push(`${label}: could not download ${tarballUrl} (HTTP ${response.status})`)
      continue
    }
    const publishedTarball = Buffer.from(await response.arrayBuffer())
    writeFileSync(path.join(scratch, 'package.tgz'), publishedTarball)
    if (expectedTarball !== undefined) {
      const integrityFailure = expectedTarballFailure(
        readFileSync(path.resolve(expectedTarball)),
        publishedTarball,
      )
      if (integrityFailure !== null) failures.push(`${label}: ${integrityFailure}`)
    }
    execFileSync('tar', ['xzf', 'package.tgz'], { cwd: scratch })

    const publishedDist = path.join(scratch, 'package', 'dist')
    const localDist = path.join(root, entry.directory, 'dist')

    const publishedFiles = treeFiles(publishedDist)
    const localFiles = treeFiles(localDist)
    if (publishedFiles === null) {
      failures.push(`${label}: published tarball has no dist/`)
      continue
    }
    if (localFiles === null) {
      failures.push(`${label}: no local dist/ to compare — build before verifying`)
      continue
    }

    const publishedManifest = JSON.parse(
      readFileSync(path.join(scratch, 'package', 'package.json'), 'utf8'),
    )
    if (publishedManifest.version !== version) {
      failures.push(`${label}: published manifest says ${publishedManifest.version}`)
    }

    // Compiled files being identical says nothing about the metadata installs
    // resolve from, so the resolution-shaping fields must match the local
    // manifest too. `null` stands in for an absent field on either side.
    for (const field of METADATA_FIELDS) {
      const published = canonical(publishedManifest[field] ?? null)
      const local = canonical(manifest[field] ?? null)
      if (published !== local) {
        failures.push(
          `${label}: published package.json ${field} is ${published}, local manifest says ${local}`,
        )
      }
    }

    for (const file of publishedFiles) {
      if (!localFiles.includes(file)) {
        failures.push(`${label}: published dist/${file} is not in the local build (stale or foreign artifact)`)
      }
    }
    for (const file of localFiles) {
      if (!publishedFiles.includes(file)) {
        failures.push(`${label}: local dist/${file} is missing from the published package`)
      }
    }
    for (const file of publishedFiles) {
      if (!localFiles.includes(file)) continue
      const a = sha256(readFileSync(path.join(publishedDist, file)))
      const b = sha256(readFileSync(path.join(localDist, file)))
      if (a !== b) failures.push(`${label}: dist/${file} differs from the local build`)
    }

    if (failures.length === 0) {
      notes.push(
        `${label}: registry bytes, ${publishedFiles.length} compiled files, and resolution metadata match exactly`,
      )
    }
  } catch (error) {
    failures.push(`${label}: verification failed (${String(error)})`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error('Published artifact verification FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

for (const note of notes) console.log(note)
console.log('Published artifacts match this checkout.')
