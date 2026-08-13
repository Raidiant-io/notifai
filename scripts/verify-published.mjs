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
 * So this runs *after* publishing and asks the only question left: is the code
 * on the registry byte-for-byte the code we meant to send? It reads npm and
 * the local build, and needs no credentials.
 *
 * Usage:
 *   node scripts/verify-published.mjs                # every publishable package
 *   node scripts/verify-published.mjs @raidiant/notifai
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execCommand, repositoryRoot } from './cross-platform.mjs'

const root = repositoryRoot
const failures = []
const notes = []

const PACKAGES = [
  { name: '@raidiant/notifai', directory: 'apps/cli' },
  { name: '@raidiant/notifai-protocol', directory: 'packages/protocol' },
]

const requested = process.argv.slice(2)
const selected = requested.length === 0 ? PACKAGES : PACKAGES.filter((p) => requested.includes(p.name))
for (const name of requested) {
  if (!PACKAGES.some((p) => p.name === name)) failures.push(`unknown package ${name}`)
}

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex')

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
    tarballUrl = execCommand('npm', ['view', label, 'dist.tarball'], {
      encoding: 'utf8',
    }).trim()
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
    writeFileSync(path.join(scratch, 'package.tgz'), Buffer.from(await response.arrayBuffer()))
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

    const publishedVersion = JSON.parse(
      readFileSync(path.join(scratch, 'package', 'package.json'), 'utf8'),
    ).version
    if (publishedVersion !== version) {
      failures.push(`${label}: published manifest says ${publishedVersion}`)
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
      notes.push(`${label}: ${publishedFiles.length} compiled files match the local build exactly`)
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
