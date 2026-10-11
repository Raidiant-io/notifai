import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { inspectWindowsNpmReaders } from '../apps/cli/dist/windows-npm-maintenance.js'

it('scopes npm repair to the package while unrelated applications keep running', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-reader-scope-'))
  const prefix = path.join(root, 'npm with spaces')
  const packageRoot = path.join(prefix, 'node_modules', '@raidiant', 'notifai')
  const entry = path.join(packageRoot, 'dist', 'main.js')
  const children = new Set()
  const program = `process.send('ready'); process.on('message', () => process.exit(0)); setTimeout(() => process.exit(2), 60000).unref();`
  async function start(file, args = [], runtimeArgs = [], executable = process.execPath) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, program)
    const child = spawn(executable, [...runtimeArgs, file, ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    children.add(child)
    await once(child, 'message', { signal: AbortSignal.timeout(10000) })
    return child
  }
  async function stop(child) {
    if (child.exitCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) })
      child.send('finish')
      await exited
    }
    children.delete(child)
  }
  const scope = { observation: { schema: 1, source: 'affected-shell', consumer: 'windows-direct-cli',
    command: path.join(prefix, 'notifai.cmd'), prefix, state_roots: [path.join(root, 'state')],
    producers: [{ pid: 2147483000, start: 'windows-filetime:1', executable: path.join(root, 'fixture-app.exe') }] },
    prefix: { path: prefix, identity: 'fixture' }, states: [] }
  try {
    mkdirSync(packageRoot, { recursive: true })
    // An unrelated service, a similarly named package, and a program mentioning
    // the target as data must remain running. No user process is stopped.
    const unrelated = await start(path.join(root, 'unrelated service', 'server.js'), [entry])
    const neighbor = await start(path.join(prefix, 'node_modules', '@raidiant', 'notifai-other', 'dist', 'main.js'))
    const clear = inspectWindowsNpmReaders(scope)
    assert.equal(clear.uncertain, false)
    assert.ok(!clear.readers.some(reader => [unrelated.pid, neighbor.pid].includes(reader.pid)), 'Unrelated Node applications must not block npm repair')
    const legacy = await start(entry)
    const busy = inspectWindowsNpmReaders(scope)
    assert.equal(busy.uncertain, false)
    assert.ok(busy.readers.some(reader => reader.pid === legacy.pid && reader.reason === 'package'), 'The actual package reader must block replacement')
    assert.ok(!busy.readers.some(reader => [unrelated.pid, neighbor.pid].includes(reader.pid)))
    await stop(legacy)
    const preload = path.join(packageRoot, 'dependency.cjs')
    writeFileSync(preload, 'module.exports = {}')
    const loading = await start(path.join(root, 'preloading service.cjs'), [], ['--require', preload])
    assert.ok(inspectWindowsNpmReaders(scope).readers.some(reader => reader.pid === loading.pid && reader.reason === 'package'), 'An actual package preload must remain protected')
    await stop(loading)
    const recordedApp = scope.observation.producers[0].executable
    copyFileSync(process.execPath, recordedApp)
    const restarted = await start(path.join(root, 'recorded-app.cjs'), [], [], recordedApp)
    const application = inspectWindowsNpmReaders(scope)
    assert.ok(application.readers.some(reader => reader.pid === restarted.pid && reader.reason === 'application'), 'A restarted observed application must remain protected')
    await stop(restarted)
    const differentApp = path.join(root, 'unrelated application', path.basename(recordedApp))
    mkdirSync(path.dirname(differentApp), { recursive: true })
    copyFileSync(process.execPath, differentApp)
    const sameName = await start(path.join(root, 'different-app.cjs'), [], [], differentApp)
    const settled = inspectWindowsNpmReaders(scope)
    assert.equal(settled.uncertain, false)
    assert.equal(settled.readers.length, 0, 'An unrelated busy machine must admit the scoped repair')
    assert.equal(unrelated.exitCode, null)
    assert.equal(neighbor.exitCode, null)
    assert.equal(sameName.exitCode, null)
    console.log('PASS: unrelated live applications ignored; exact package reader blocks; scoped repair clears without stopping unrelated work')
  } finally {
    await Promise.all([...children].map(stop))
    rmSync(root, { recursive: true, force: true })
  }
})
