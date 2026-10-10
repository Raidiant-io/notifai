import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runGuardedNpm } from '../apps/cli/dist/npm-conversion-process.js'

describe('Windows npm entry guards follow the actual writer', { skip: process.platform !== 'win32' }, () => {
  let root, launcher, probe
  const children = new Set()
  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-guard-'))
    execFileSync(process.execPath, ['scripts/build-launcher.mjs', root], { stdio: 'pipe' })
    launcher = path.join(root, 'notifai.exe')
    // A separate process distinguishes lost sharing denial from a difference
    // between Node's open and the guard's native open. Used only on failure.
    probe = path.join(root, 'probe.exe')
    const source = path.join(root, 'probe.c')
    writeFileSync(source, String.raw`#include <windows.h>
#include <stdio.h>
#include <wchar.h>
int wmain(int argc, wchar_t **argv) {
  if (argc != 2) return 2;
  wchar_t extended[32768];
  if (swprintf(extended, 32768, L"\\\\?\\%ls", argv[1]) < 0) return 2;
  const DWORD flags[2] = { FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS };
  printf("[");
  for (int p = 0; p < 2; p++) for (int f = 0; f < 2; f++) {
    HANDLE h = CreateFileW(p ? extended : argv[1], GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, flags[f], NULL);
    DWORD error = h == INVALID_HANDLE_VALUE ? GetLastError() : 0;
    BY_HANDLE_FILE_INFORMATION info = {0};
    if (h != INVALID_HANDLE_VALUE) { GetFileInformationByHandle(h, &info); CloseHandle(h); }
    ULARGE_INTEGER id; id.LowPart = info.nFileIndexLow; id.HighPart = info.nFileIndexHigh;
    printf("%s{\"extended\":%d,\"backup\":%d,\"error\":%lu,\"volume\":%lu,\"file_id\":\"%llu\"}",
      p || f ? "," : "", p, f, error, info.dwVolumeSerialNumber, id.QuadPart);
  }
  printf("]\n");
  return 0;
}
`)
    execFileSync('cl.exe', ['/nologo', '/O2', '/MT', '/W4', '/WX', '/std:c11', '/D_CRT_SECURE_NO_WARNINGS',
      `/Fo${path.join(root, 'probe.obj')}`, `/Fe${probe}`, source], { cwd: root, stdio: 'pipe' })
  })
  after(async () => {
    for (const child of children) child.kill('SIGKILL')
    await Promise.all([...children].map(child => child.completion.catch(() => {})))
    if (root) rmSync(root, { recursive: true, force: true })
  })
  async function until(check) {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Owned guard fixture deadline')
      await delay(10)
    }
  }
  function prepare() {
    const directory = mkdtempSync(path.join(root, 'operation-'))
    const entries = ['main.js', 'main-run.js'].map(name => path.join(directory, name))
    entries.forEach((file, i) => writeFileSync(file, `legacy entry ${i}\n`))
    const digests = entries.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'))
    const marker = path.join(directory, 'started.json'), finish = path.join(directory, 'finish')
    const manager = path.join(directory, 'manager.cjs')
    writeFileSync(manager, `const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(4), input: fs.readFileSync(0, 'utf8') }));
const poll = setInterval(() => { if (fs.existsSync(process.argv[3])) { clearInterval(poll); process.exit(23); } }, 10);
setTimeout(() => process.exit(19), 15000).unref();
`)
    const args = ['', 'two words', 'quote"inside', 'trailing\\', 'two\\\\"quotes', '東京 café']
    return { directory, entries, digests, marker, finish, manager, args }
  }
  function start() {
    const { entries, digests, marker, finish, manager, args } = prepare()
    const child = spawn(launcher, ['--internal-npm-guard', ...entries, process.execPath, manager, marker, finish, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    children.add(child)
    let output = '', error = '', announced = false
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => { if (!announced) reject(new Error(`Guard exited before admission: ${error}`)) })
      child.stderr.on('data', bytes => { error += bytes.toString() })
      child.stdout.on('data', bytes => {
        output += bytes.toString()
        if (!announced && output.includes('\n')) {
          announced = true
          try { resolve(JSON.parse(output.slice(0, output.indexOf('\n')))) } catch (failure) { reject(failure) }
        }
      })
    })
    child.completion = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, error }) })
    })
    void child.completion.catch(() => {})
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    void child.completion.finally(() => clearTimeout(timer)).catch(() => {})
    return { child, ready, entries, marker, finish, args, digests, diagnostic: () => ({ output, error,
      guard_exit: child.exitCode, guard_pid: child.pid }) }
  }
  function entryAccess(file, allowed) {
    for (const operation of ['readFileSync', 'writeFileSync']) {
      const source = operation === 'readFileSync' ? 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))'
        : 'require("node:fs").writeFileSync(process.argv[1], "replacement")'
      const check = spawnSync(process.execPath, ['-e', source, file], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      assert.equal(check.error, undefined)
      if (allowed) assert.equal(check.status, 0, check.stderr)
      else {
        const native = check.status === 0 ? spawnSync(probe, [file], { encoding: 'utf8', timeout: 5000, windowsHide: true }) : null
        assert.notEqual(check.status, 0, `Legacy entry unexpectedly admitted ${operation}: ${file}; output=${JSON.stringify(check.stdout)}; native=${JSON.stringify(native && { status: native.status, stdout: native.stdout, stderr: native.stderr })}`)
      }
    }
  }
  async function admitted(fixture) {
    const ready = await fixture.ready
    assert.match(ready.start, /^windows-filetime:\d+$/)
    assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0)
    assert.deepEqual(ready.guard_sha256, fixture.digests)
    fixture.managerPid = ready.pid
    assert.equal(existsSync(fixture.marker), false)
    try { fixture.entries.forEach(file => entryAccess(file, false)) }
    catch (error) {
      await delay(20)
      throw new Error(`${error.message}; ${JSON.stringify(fixture.diagnostic())}`, { cause: error })
    }
  }
  it('starts only after GO, preserves argv, supplies EOF stdin and returns the manager exit', async () => {
    const f = start(); await admitted(f)
    f.child.stdin.end('G')
    await until(() => existsSync(f.marker))
    assert.deepEqual(JSON.parse(readFileSync(f.marker, 'utf8')), { args: f.args, input: '' })
    f.entries.forEach(file => entryAccess(file, false))
    writeFileSync(f.finish, 'finish')
    assert.equal((await f.child.completion).code, 23)
    f.entries.forEach(file => entryAccess(file, true))
  })
  it('does no manager work if its caller closes before GO', async () => {
    const f = start(); await admitted(f)
    f.child.stdin.end()
    assert.equal((await f.child.completion).code, 1)
    assert.equal(existsSync(f.marker), false)
    f.entries.forEach(file => entryAccess(file, true))
  })
  it('rejects an unexpected GO byte without executing the manager', async () => {
    const f = start(); await admitted(f)
    f.child.stdin.end('X')
    assert.equal((await f.child.completion).code, 1)
    assert.equal(existsSync(f.marker), false)
    f.entries.forEach(file => entryAccess(file, true))
  })
  for (const started of [false, true]) it(`terminates its exact manager on supervisor death (${started ? 'after' : 'before'} GO)`, async () => {
    const f = start(); await admitted(f)
    if (started) { f.child.stdin.end('G'); await until(() => existsSync(f.marker)) }
    f.child.kill('SIGKILL')
    await f.child.completion
    // Job closure starts termination; supervisor exit does not prove that
    // the actual writer has finished releasing its inherited guards.
    await until(() => {
      try { process.kill(f.managerPid, 0); return false }
      catch (error) { if (error.code === 'ESRCH') return true; throw error }
    })
    assert.equal(existsSync(f.marker), started)
    f.entries.forEach(file => entryAccess(file, true))
  })
  for (const failure of ['missing executable', 'command overflow']) it(`releases guards after ${failure}`, () => {
    const directory = mkdtempSync(path.join(root, 'failure-'))
    const entries = ['main.js', 'main-run.js'].map(name => path.join(directory, name))
    entries.forEach(file => writeFileSync(file, 'legacy entry\n'))
    const executable = failure === 'missing executable' ? path.join(directory, 'absent.exe') : process.execPath
    // The supervisor's own command fits Windows' limit; CRT quoting inside
    // the guard doubles this trailing backslash sequence beyond that limit.
    const args = failure === 'command overflow' ? ['\\'.repeat(17_000)] : []
    const result = spawnSync(launcher, ['--internal-npm-guard', ...entries, executable, ...args], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    entries.forEach(file => entryAccess(file, true))
  })
  it('persists the suspended manager before the client authorizes it once', async () => {
    const f = prepare(), receipt = path.join(f.directory, 'receipt.json')
    const result = await runGuardedNpm({ launcher, entries: f.entries, expectedHashes: f.digests,
      executable: process.execPath, args: [f.manager, f.marker, f.finish, ...f.args], cwd: f.directory, env: process.env,
      admit(manager) {
        assert.equal(existsSync(f.marker), false)
        f.entries.forEach(file => entryAccess(file, false))
        writeFileSync(receipt, JSON.stringify(manager))
        writeFileSync(f.finish, 'exit after first effect')
      } })
    assert.equal(result.failure, undefined)
    assert.equal(result.started, true)
    assert.equal(result.exit_code, 23)
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), result.manager)
    assert.deepEqual(JSON.parse(readFileSync(f.marker, 'utf8')), { args: f.args, input: '' })
    f.entries.forEach(file => entryAccess(file, true))
  })
  for (const failure of ['changed entry', 'old reader']) it(`client sends no GO for ${failure}`, async () => {
    const f = prepare()
    let admitted = false
    const result = await runGuardedNpm({ launcher, entries: f.entries,
      expectedHashes: failure === 'changed entry' ? ['0'.repeat(64), f.digests[1]] : f.digests,
      executable: process.execPath, args: [f.manager, f.marker, f.finish], cwd: f.directory, env: process.env,
      admit() { admitted = true; throw new Error('Old reader is still alive') } })
    assert.equal(admitted, failure === 'old reader')
    assert.equal(result.started, false)
    assert.ok(result.manager)
    assert.ok(result.failure)
    assert.equal(existsSync(f.marker), false)
    f.entries.forEach(file => entryAccess(file, true))
  })
  it('refuses rejected asynchronous admission without crashing its caller', async () => {
    const f = prepare()
    const result = await runGuardedNpm({ launcher, entries: f.entries, expectedHashes: f.digests,
      executable: process.execPath, args: [f.manager, f.marker, f.finish], cwd: f.directory, env: process.env,
      async admit() { throw new Error('Reader observation failed') } })
    assert.equal(result.started, false)
    assert.match(result.failure, /synchronously/)
    assert.equal(existsSync(f.marker), false)
    await delay(20) // An unhandled rejection fails this test even after return.
    f.entries.forEach(file => entryAccess(file, true))
  })
  it('retains its receipt after a post-GO deadline and terminates the exact manager', async () => {
    const f = prepare(), receipt = path.join(f.directory, 'receipt.json')
    const result = await runGuardedNpm({ launcher, entries: f.entries, expectedHashes: f.digests,
      executable: process.execPath, args: [f.manager, f.marker, f.finish], cwd: f.directory, env: process.env,
      timeoutMs: 2000, admit(manager) { writeFileSync(receipt, JSON.stringify(manager)) } })
    assert.equal(result.started, true)
    assert.match(result.failure, /deadline/)
    assert.ok(existsSync(f.marker))
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), result.manager)
    await until(() => {
      try { process.kill(result.manager.pid, 0); return false }
      catch (error) { if (error.code === 'ESRCH') return true; throw error }
    })
    f.entries.forEach(file => entryAccess(file, true))
  })
})
