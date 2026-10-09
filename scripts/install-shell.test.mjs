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
    const run = () => spawnSync('/bin/sh', [path.join(repositoryRoot, 'scripts/install.sh'), '--json', '--version', '1.0.0', '--no-init', '--no-path', '--migrate-npm'], {
      cwd: root, env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: temporary, BOOTSTRAP_FIXTURES: fixtures, BOOTSTRAP_MARKER: marker, BOOTSTRAP_HOME: root, HOME: root },
      encoding: 'utf8', timeout: 20_000,
    })
    const first = run()
    assert.equal(first.status, 7, first.stderr || first.stdout)
    const args = readFileSync(marker, 'utf8').trim().split('\n')
    assert.deepEqual(args.slice(0, 3), ['install', '--source', 'shell'])
    assert.deepEqual(args.slice(-6), ['--version', '1.0.0', '--json', '--no-init', '--no-path', '--migrate-npm'])
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
      ['install', '--source', 'shell', '--version', '1.0.0', '--json', '--no-init', '--no-path', '--migrate-npm'])
    rmSync(marker)
    chmodSync(installedBin, 0o777)
    const unsafeExisting = run()
    assert.equal(unsafeExisting.status, 1)
    assert.match(JSON.parse(unsafeExisting.stdout).message, /privately owned/)
    assert.equal(existsSync(marker), false)

  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('piped human installer restores terminal input once and explicit JSON stays noninteractive', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-shell-tty-'))
  try {
    const bin = path.join(root, 'tools'), nativeBin = path.join(root, '.notifai', 'bin'), marker = path.join(root, 'calls.jsonl')
    mkdirSync(bin); mkdirSync(nativeBin, { recursive: true, mode: 0o700 })
    const executable = (name, script) => writeFileSync(path.join(bin, name), script, { mode: 0o700 })
    executable('uname', '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo aarch64;; esac\n')
    executable('getent', '#!/bin/sh\nprintf "fixture:x:1000:1000:fixture:%s:/bin/sh\\n" "$BOOTSTRAP_HOME"\n')
    if (process.platform === 'darwin') executable('stat', '#!/bin/sh\nexec /usr/bin/stat -f "%u %Lp" "$3"\n')
    // The native command is substituted; actual product TTY selection runs.
    writeFileSync(path.join(nativeBin, 'notifai'), `#!${process.execPath}
const fs = require('node:fs');
import(${JSON.stringify(path.join(repositoryRoot, 'apps/cli/dist/commands-io.js'))}).then(({realIo}) => {
  fs.appendFileSync(process.env.BOOTSTRAP_MARKER, JSON.stringify({interactive: realIo().interactive, args: process.argv.slice(2)}) + '\\n');
});
`, { mode: 0o700 })
    const python = `import os, pty, select, signal, time
pid, fd = pty.fork()
if pid == 0:
    os.execv('/bin/sh', ['sh', '-c', 'cat "$BOOTSTRAP_SCRIPT" | /bin/sh -s -- ' + os.environ['BOOTSTRAP_ARGS']])
deadline = time.monotonic() + 15
status = None
while time.monotonic() < deadline:
    if select.select([fd], [], [], 0.05)[0]:
        try: os.read(fd, 65536)
        except OSError: pass
    got, result = os.waitpid(pid, os.WNOHANG)
    if got:
        status = result
        break
if status is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    raise RuntimeError('piped installer did not exit')
os.close(fd)
raise SystemExit(os.waitstatus_to_exitcode(status))
`
    for (const [args, interactive] of [['', true], ['--json --no-init', false]]) {
      const result = spawnSync('python3', ['-c', python], { encoding: 'utf8', timeout: 20_000,
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, BOOTSTRAP_HOME: root, BOOTSTRAP_SCRIPT: path.join(repositoryRoot, 'scripts/install.sh'),
          BOOTSTRAP_MARKER: marker, BOOTSTRAP_ARGS: args } })
      assert.equal(result.status, 0, result.stderr)
      const calls = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.equal(calls.length, 1)
      assert.equal(calls[0].interactive, interactive)
      assert.deepEqual(calls[0].args, ['install', '--source', 'shell', ...(args ? ['--json', '--no-init'] : [])])
      rmSync(marker)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
