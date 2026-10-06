#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export function admitNativeCandidate({ directory, target, expectedSha }) {
  const extension = target.startsWith('bun-windows-') ? '.exe' : ''
  assert.equal(target, `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`, 'Finalization must use the native target')
  assert.match(expectedSha, /^[a-f0-9]{40}$/)
  const root = lstatSync(directory)
  assert.ok(root.isDirectory() && !root.isSymbolicLink(), 'Candidate root cannot be linked')
  const regular = (name, limit = 256 * 1024) => {
    const file = path.join(directory, name), stat = lstatSync(file)
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'Candidate input must be a bounded regular file')
    return readFileSync(file)
  }
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const checkBytes = regular('check.json'), check = JSON.parse(checkBytes)
  const archiveRoot = lstatSync(path.join(directory, 'archive'))
  assert.ok(archiveRoot.isDirectory() && !archiveRoot.isSymbolicLink(), 'Candidate archive root cannot be linked')
  const metadata = JSON.parse(regular('archive/artifact.json')), installed = JSON.parse(regular('archive-check.json'))
  assert.ok(check.ok === true && check.build.target === target && check.build.sourceRevision === expectedSha && check.build.sourceDirty === false,
    'Candidate native source receipt differs')
  assert.deepEqual(JSON.parse(regular(`notifai-runtime${extension}.build.json`)), check.build, 'Embedded build sidecar differs')
  assert.deepEqual(metadata.build, check.build, 'Candidate package build differs')
  assert.equal(metadata.check_sha256, hash(checkBytes), 'Candidate check receipt changed')
  assert.ok(installed.ok === true && installed.target === target && installed.archive_sha256 === metadata.artifact.sha256,
    'Candidate archive installation was not verified')
  for (const [name, digest] of [[`notifai${extension}`, check.launcher_sha256], [`notifai-runtime${extension}`, check.runtime_sha256]]) {
    assert.equal(hash(regular(name, 512 * 1024 * 1024)), digest, 'Candidate executable changed after CI')
  }
  // upload-artifact does not preserve executable mode. Restore it only after
  // authenticating bytes against the admitted native receipt.
  if (process.platform !== 'win32') for (const name of ['notifai', 'notifai-runtime']) chmodSync(path.join(directory, name), 0o755)
  // This is an exclusive downloaded workspace. Discard only candidate packaging;
  // finalization creates fresh checks and reviewed-material archives from it.
  rmSync(path.join(directory, 'archive'), { recursive: true, force: true })
  rmSync(path.join(directory, 'archive-check.json'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, target: { type: 'string' }, 'expected-sha': { type: 'string' } } })
  assert.ok(values.directory && values.target, 'Explicit candidate directory and target are required')
  admitNativeCandidate({ ...values, expectedSha: values['expected-sha'] })
}
