import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { admitNativeCandidate } from './admit-native-candidate.mjs'
import { prepareReviewedMaterials } from './prepare-reviewed-materials.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const target = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
test('finalization admits unchanged native executables before removing candidate packaging', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'notifai-finalization-')), expectedSha = 'a'.repeat(40)
  const extension = process.platform === 'win32' ? '.exe' : ''
  const build = { target, sourceRevision: expectedSha, sourceDirty: false }
  const check = JSON.stringify({ ok: true, build, launcher_sha256: hash('launcher'), runtime_sha256: hash('runtime') })
  try {
    mkdirSync(path.join(directory, 'archive'))
    for (const [name, bytes] of Object.entries({
      [`notifai${extension}`]: 'launcher', [`notifai-runtime${extension}`]: 'runtime',
      [`notifai-runtime${extension}.build.json`]: JSON.stringify(build), 'check.json': check,
      'archive/artifact.json': JSON.stringify({ build, check_sha256: hash(check), artifact: { sha256: 'b'.repeat(64) } }),
      'archive-check.json': JSON.stringify({ ok: true, target, archive_sha256: 'b'.repeat(64) }),
    })) writeFileSync(path.join(directory, name), bytes)
    writeFileSync(path.join(directory, `notifai${extension}`), 'tampered')
    assert.throws(() => admitNativeCandidate({ directory, target, expectedSha }), /executable changed/)
    assert.ok(existsSync(path.join(directory, 'archive/artifact.json')))
    writeFileSync(path.join(directory, `notifai${extension}`), 'launcher')
    admitNativeCandidate({ directory, target, expectedSha })
    assert.equal(existsSync(path.join(directory, 'archive')), false)
    assert.equal(readFileSync(path.join(directory, `notifai-runtime${extension}`), 'utf8'), 'runtime')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('production packaging requires exact reviewed material bytes and refuses candidate policy', () => {
  const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'notifai-reviewed-materials-'))
  const output = path.join(sourceRoot, 'output'), file = path.join(sourceRoot, 'materials', target, 'licenses', 'runtime.txt')
  const policy = { schema: 1, status: 'approved', runtime: 'bun-1.4.2', targets: { [target]: [{ path: 'licenses/runtime.txt', bytes: 7, sha256: hash('license') }] } }
  const save = () => writeFileSync(path.join(sourceRoot, 'release-materials.json'), JSON.stringify(policy))
  try {
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'license'); save()
    writeFileSync(file, 'changed')
    assert.throws(() => prepareReviewedMaterials({ sourceRoot, target, output }), /hash differs/)
    assert.equal(existsSync(output), false)
    writeFileSync(file, 'license'); policy.status = 'candidate'; save()
    assert.throws(() => prepareReviewedMaterials({ sourceRoot, target, output }), /not ready/)
    policy.status = 'approved'; save()
    prepareReviewedMaterials({ sourceRoot, target, output })
    assert.equal(readFileSync(path.join(output, 'licenses/runtime.txt'), 'utf8'), 'license')
    assert.throws(() => prepareReviewedMaterials({ sourceRoot, target, output }), /EEXIST/)
  } finally { rmSync(sourceRoot, { recursive: true, force: true }) }
})

test('macOS finalization calls codesign and the keychain the way the real tools accept', () => {
  const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
  // codesign reads a bare -R value as a requirement file; requirement text needs the -R= form.
  for (const name of ['sign-macos-standalone.mjs', 'verify-standalone-archive.mjs', 'install.sh', '../apps/cli/npm/platform.mjs']) {
    assert.doesNotMatch(read(name), /'-R',|\s-R\s/, name)
  }
  const signing = read('sign-macos-standalone.mjs')
  // --keychain only narrows the user's keychain list: the list holds the
  // temporary keychain before signing and gets its previous value back.
  const listed = signing.indexOf("'list-keychains', '-d', 'user', '-s', keychain"), signed = signing.indexOf("'--sign'")
  assert.ok(listed > 0 && listed < signed)
  assert.match(signing, /finally \{[\s\S]*'list-keychains', '-d', 'user', '-s', \.\.\.searchList/)
  // A ticket lookup made right after acceptance fails, so the check waits and retries.
  assert.match(signing, /pause\(TICKET_FIRST_CHECK_MS\)[\s\S]*notarizationTicket\(/)
})
