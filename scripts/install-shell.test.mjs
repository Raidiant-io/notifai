import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { repositoryRoot } from './cross-platform.mjs'
const require = createRequire(path.join(repositoryRoot, 'apps/cli/package.json'))
const { pack } = require('tar-stream')
const hash = data => createHash('sha256').update(data).digest('hex')
async function archive(entries) {
  const writer = pack(), chunks = []
  const output = (async () => { for await (const chunk of writer) chunks.push(chunk) })()
  for (const [name, value] of entries) await new Promise((resolve, reject) => writer.entry({ name, size: Buffer.byteLength(value), mode: 0o755, type: 'file' }, value, error => error ? reject(error) : resolve()))
  writer.finalize(); await output
  return gzipSync(Buffer.concat(chunks))
}
test('shell bootstrap validates downloads and archive paths before passing exact native installer arguments', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-shell-bootstrap-'))
  try {
    const fixtures = path.join(root, 'fixtures'), bin = path.join(root, 'tools'), temporary = path.join(root, 'temp')
    for (const directory of [fixtures, bin, temporary]) mkdirSync(directory)
    const executable = (name, script) => { const file = path.join(bin, name); writeFileSync(file, script); chmodSync(file, 0o700) }
    // Only OS/transport probes are fixture adapters. The shipped shell code,
    // checksum tools, tar parser and actual extraction run unchanged.
    executable('uname', '#!/bin/sh\ncase "$1" in -s) printf "Linux\\n";; -m) printf "aarch64\\n";; *) exit 1;; esac\n')
    executable('getent', '#!/bin/sh\nprintf \"fixture:x:1000:1000:fixture:%s:/bin/sh\\n\" \"$BOOTSTRAP_HOME\"\n')
    if (process.platform === 'darwin') executable('stat', '#!/bin/sh\nexec /usr/bin/stat -f \"%u %Lp\" \"$3\"\n')
    executable('getconf', '#!/bin/sh\nprintf "glibc 2.39\\n"\n')
    executable('curl', `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in --output) output=$2; shift 2;; https://*) url=$1; shift;; *) shift;; esac
done
case "$url" in
  */stable.bootstrap.tsv) source=channel.tsv;;
  */bootstrap.tsv) source=bootstrap.tsv;;
  */inventory.json) source=inventory.json;;
  */notifai-1.0.0-linux-arm64.tar.gz) source=archive.tar.gz;;
  *) exit 1;;
esac
/bin/cp "$BOOTSTRAP_FIXTURES/$source" "$output" || exit 1
printf '200\\n\\n'
`)
    const launcher = '#!/bin/sh\nprintf "%s\\n" "$@" > "$BOOTSTRAP_MARKER"\nexit 7\n', runtime = 'fixture runtime'
    const inventory = 'fixture signed inventory bytes'
    writeFileSync(path.join(fixtures, 'inventory.json'), inventory)
    writeFileSync(path.join(fixtures, 'channel.tsv'), `notifai-channel-v1\tstable\t1\t1.0.0\t${hash(inventory)}\n`)
    const setArchive = async (entries) => {
      const bytes = await archive(entries)
      writeFileSync(path.join(fixtures, 'archive.tar.gz'), bytes)
      writeFileSync(path.join(fixtures, 'bootstrap.tsv'), `notifai-bootstrap-v1\t1.0.0\t${hash(inventory)}\nartifact\tbun-linux-arm64\tnotifai-1.0.0-linux-arm64.tar.gz\t${bytes.length}\t${hash(bytes)}\t${hash(launcher)}\t${hash(runtime)}\n`)
    }
    const members = [['notifai', launcher], ['notifai-runtime', runtime], ['licenses/NOTICE.txt', 'fixture notice']]
    await setArchive(members)
    const marker = path.join(root, 'called')
    const run = () => spawnSync('/bin/sh', [path.join(repositoryRoot, 'scripts/install.sh'), '--json', '--version', '1.0.0', '--no-init', '--no-path'], {
      cwd: root, env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: temporary, BOOTSTRAP_FIXTURES: fixtures, BOOTSTRAP_MARKER: marker, BOOTSTRAP_HOME: root, HOME: root },
      encoding: 'utf8', timeout: 20_000,
    })
    const first = run()
    assert.equal(first.status, 7, first.stderr || first.stdout)
    const args = readFileSync(marker, 'utf8').trim().split('\n')
    assert.deepEqual(args.slice(0, 3), ['install', '--source', 'shell'])
    assert.deepEqual(args.slice(-5), ['--version', '1.0.0', '--json', '--no-init', '--no-path'])
    rmSync(marker)
    writeFileSync(path.join(fixtures, 'archive.tar.gz'), 'tampered')
    const badHash = run()
    assert.equal(badHash.status, 1)
    assert.match(JSON.parse(badHash.stdout).message, /digest or size/)
    assert.equal(existsSync(marker), false)
    await setArchive([...members, ['../escape', 'untrusted']])
    const unsafe = run()
    assert.equal(unsafe.status, 1)
    assert.match(JSON.parse(unsafe.stdout).message, /unsafe/)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(path.join(root, 'escape')), false)
    // A trusted installed command owns resumption. Even broken transport bytes
    // must not trigger discovery, downloads, or an implicit runtime update.
    const installedBin = path.join(root, '.notifai', 'bin')
    mkdirSync(installedBin, { recursive: true, mode: 0o700 })
    const installed = path.join(installedBin, 'notifai')
    writeFileSync(installed, launcher, { mode: 0o700 })
    const reused = run()
    assert.equal(reused.status, 7, reused.stderr || reused.stdout)
    assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'),
      ['install', '--source', 'shell', '--version', '1.0.0', '--json', '--no-init', '--no-path'])
    rmSync(marker)
    chmodSync(installedBin, 0o777)
    const unsafeExisting = run()
    assert.equal(unsafeExisting.status, 1)
    assert.match(JSON.parse(unsafeExisting.stdout).message, /privately owned/)
    assert.equal(existsSync(marker), false)

  } finally { rmSync(root, { recursive: true, force: true }) }
})
