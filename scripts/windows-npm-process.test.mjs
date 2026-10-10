import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runNpmManager } from '../apps/cli/dist/npm-conversion-process.js'
import { inspectWindowsNpmReaders } from '../apps/cli/dist/windows-npm-maintenance.js'

describe('Windows npm manager custody', { skip: process.platform !== 'win32' }, () => {
  let root, launcher
  const children = new Set()
  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-process-'))
    // Installed-artifact checks may supply an independently verified launcher.
    // CI builds the current source; a missing compiler never silently falls back.
    launcher = process.env['NOTIFAI_TEST_NPM_LAUNCHER']
    if (launcher) {
      assert.ok(path.isAbsolute(launcher))
      assert.ok(lstatSync(launcher).isFile() && !lstatSync(launcher).isSymbolicLink())
    } else {
      execFileSync(process.execPath, ['scripts/build-launcher.mjs', root], { stdio: 'pipe' })
      launcher = path.join(root, 'notifai.exe')
    }
  })
  after(async () => {
    for (const child of children) child.kill('SIGKILL')
    await Promise.all([...children].map(child => child.completion.catch(() => {})))
    if (root) rmSync(root, { recursive: true, force: true })
  })
  async function until(check) {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Owned manager fixture deadline')
      await delay(10)
    }
  }
  function prepare() {
    const directory = mkdtempSync(path.join(root, 'operation-'))
    const marker = path.join(directory, 'started.json'), finish = path.join(directory, 'finish')
    const manager = path.join(directory, 'manager.cjs')
    writeFileSync(manager, `const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(4), input: fs.readFileSync(0, 'utf8') }));
const poll = setInterval(() => { if (fs.existsSync(process.argv[3])) { clearInterval(poll); process.exit(23); } }, 10);
setTimeout(() => process.exit(19), 15000).unref();
`)
    const args = ['', 'two words', 'quote"inside', 'trailing\\', 'two\\\\"quotes', '東京 café']
    return { directory, marker, finish, manager, args }
  }
  function start() {
    const { marker, finish, manager, args } = prepare()
    const child = spawn(launcher, ['--internal-npm-manager', process.execPath, manager, marker, finish, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    children.add(child)
    let output = '', error = '', announced = false
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => { if (!announced) reject(new Error(`Supervisor exited before admission: ${error}`)) })
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
    return { child, ready, marker, finish, args, diagnostic: () => ({ output, error,
      supervisor_exit: child.exitCode, supervisor_pid: child.pid }) }
  }
  async function admitted(fixture) {
    const ready = await fixture.ready
    assert.match(ready.start, /^windows-filetime:\d+$/)
    assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0)
    fixture.managerPid = ready.pid
    assert.equal(existsSync(fixture.marker), false)
  }
  it('starts without legacy files only after GO, preserves argv/stdin and the manager exit', async () => {
    const f = start(); await admitted(f)
    f.child.stdin.end('G')
    await until(() => existsSync(f.marker))
    assert.deepEqual(JSON.parse(readFileSync(f.marker, 'utf8')), { args: f.args, input: '' })
    writeFileSync(f.finish, 'finish')
    assert.equal((await f.child.completion).code, 23)
  })
  it('does no manager work if its caller closes before GO', async () => {
    const f = start(); await admitted(f)
    f.child.stdin.end()
    assert.equal((await f.child.completion).code, 1)
    assert.equal(existsSync(f.marker), false)
  })
  it('rejects an unexpected GO byte without executing the manager', async () => {
    const f = start(); await admitted(f)
    f.child.stdin.end('X')
    assert.equal((await f.child.completion).code, 1)
    assert.equal(existsSync(f.marker), false)
  })
  for (const started of [false, true]) it(`terminates its exact manager on supervisor death (${started ? 'after' : 'before'} GO)`, async () => {
    const f = start(); await admitted(f)
    if (started) { f.child.stdin.end('G'); await until(() => existsSync(f.marker)) }
    f.child.kill('SIGKILL')
    await f.child.completion
    // Job closure starts termination; supervisor exit does not prove that
    // the actual writer has exited.
    await until(() => {
      try { process.kill(f.managerPid, 0); return false }
      catch (error) { if (error.code === 'ESRCH') return true; throw error }
    })
    assert.equal(existsSync(f.marker), started)
  })
  for (const failure of ['missing executable', 'command overflow']) it(`does not start a manager after ${failure}`, () => {
    const directory = mkdtempSync(path.join(root, 'failure-'))
    const executable = failure === 'missing executable' ? path.join(directory, 'absent.exe') : process.execPath
    // The supervisor's own command fits Windows' limit; CRT quoting inside
    // the supervisor doubles this trailing backslash sequence beyond that limit.
    const args = failure === 'command overflow' ? ['\\'.repeat(17_000)] : []
    const result = spawnSync(launcher, ['--internal-npm-manager', executable, ...args], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, failure === 'missing executable' ? /suspended manager creation/ : /argument bounds/)
  })
  it('persists the suspended manager before the client authorizes it once', async () => {
    const f = prepare(), receipt = path.join(f.directory, 'receipt.json')
    const result = await runNpmManager({ launcher,
      executable: process.execPath, args: [f.manager, f.marker, f.finish, ...f.args], cwd: f.directory, env: process.env,
      admit(manager) {
        assert.equal(existsSync(f.marker), false)
        writeFileSync(receipt, JSON.stringify(manager))
        writeFileSync(f.finish, 'exit after first effect')
      } })
    assert.equal(result.failure, undefined)
    assert.equal(result.started, true)
    assert.equal(result.exit_code, 23)
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), result.manager)
    assert.deepEqual(JSON.parse(readFileSync(f.marker, 'utf8')), { args: f.args, input: '' })
  })
  it('sends no GO while a known old reader remains', async () => {
    const f = prepare()
    let admitted = false
    const result = await runNpmManager({ launcher,
      executable: process.execPath, args: [f.manager, f.marker, f.finish], cwd: f.directory, env: process.env,
      admit() { admitted = true; throw new Error('Old reader is still alive') } })
    assert.equal(admitted, true)
    assert.equal(result.started, false)
    assert.ok(result.manager)
    assert.ok(result.failure)
    assert.equal(existsSync(f.marker), false)
  })
  for (const exact of [true, false]) it(`observes the suspended manager before GO with ${exact ? 'its exact' : 'a mismatched'} identity`, async () => {
    const f = prepare()
    const scope = { observation: { prefix: f.directory, state_roots: [f.directory], producers: [] } }
    let census
    const result = await runNpmManager({ launcher,
      executable: process.execPath, args: [f.manager, f.marker, f.finish], cwd: f.directory, env: process.env,
      admit(manager) {
        assert.equal(existsSync(f.marker), false)
        const start = `windows-filetime:${BigInt(manager.start.split(':')[1]) + 1n}`
        census = inspectWindowsNpmReaders(scope, exact ? manager : { ...manager, start })
        // The live coordinator is a separate reader and must still be observed.
        assert.ok(census.readers.some(reader => reader.pid === process.pid))
        if (census.uncertain) throw new Error('Relevant process inspection is incomplete')
        writeFileSync(f.finish, 'exit after first effect')
      } })
    assert.ok(census)
    assert.equal(census.uncertain, !exact)
    assert.equal(result.started, exact)
    assert.equal(existsSync(f.marker), exact)
    if (exact) {
      assert.equal(result.failure, undefined)
      assert.equal(result.exit_code, 23)
    } else assert.match(result.failure, /inspection is incomplete/)
  })
  it('refuses rejected asynchronous admission without crashing its caller', async () => {
    const f = prepare()
    const result = await runNpmManager({ launcher,
      executable: process.execPath, args: [f.manager, f.marker, f.finish], cwd: f.directory, env: process.env,
      async admit() { throw new Error('Reader observation failed') } })
    assert.equal(result.started, false)
    assert.match(result.failure, /synchronously/)
    assert.equal(existsSync(f.marker), false)
    await delay(20) // An unhandled rejection fails this test even after return.
  })
  it('sends no GO when admission cancels the operation synchronously', async () => {
    const f = prepare(), controller = new AbortController()
    const result = await runNpmManager({ launcher,
      executable: process.execPath, args: [f.manager, f.marker, f.finish], cwd: f.directory, env: process.env,
      signal: controller.signal, admit() { controller.abort() } })
    assert.equal(result.started, false)
    assert.ok(result.manager)
    assert.match(result.failure, /interrupted/)
    assert.equal(existsSync(f.marker), false)
  })
  it('retains its receipt after a post-GO deadline and terminates the exact manager', async () => {
    const f = prepare(), receipt = path.join(f.directory, 'receipt.json')
    const result = await runNpmManager({ launcher,
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
  })
})
