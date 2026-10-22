import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { describeScratchRoot, removeScratchRoot, scratchRootHolders } from './scratch-root.mjs'

const busy = () => Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' })

test('removes a scratch directory on the first attempt without asking who holds it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-scratch-'))
  writeFileSync(path.join(root, 'file'), 'x')
  const cleanup = removeScratchRoot(root, { holders: () => assert.fail('no holder query for a removed directory') })
  assert.deepEqual(cleanup, { removed: true, attempts: 1 })
  assert.equal(existsSync(root), false)
})

test('retries a briefly held directory until it goes away', () => {
  let calls = 0
  const cleanup = removeScratchRoot('/scratch', { delayMs: 1, holders: () => assert.fail('released in time'),
    remove: () => { if (++calls < 3) throw busy() } })
  assert.deepEqual(cleanup, { removed: true, attempts: 3 })
})

test('stops after its bounded attempts and names what still holds the directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-scratch-'))
  mkdirSync(path.join(root, 'bin'))
  writeFileSync(path.join(root, 'bin', 'notifai.exe'), 'x')
  let calls = 0
  const holder = { pid: 42, parent: 7, name: 'notifai-runtime.exe', executable: path.join(root, 'bin', 'notifai-runtime.exe'),
    command: `"${path.join(root, 'bin', 'notifai-runtime.exe')}" self-check --json` }
  const cleanup = removeScratchRoot(root, { attempts: 3, delayMs: 1, remove: () => { calls++; throw busy() },
    holders: directory => (assert.equal(directory, root), { processes: [holder] }) })
  assert.equal(calls, 3)
  assert.equal(cleanup.removed, false)
  assert.deepEqual(cleanup.remaining, [`bin${path.sep}`, path.join('bin', 'notifai.exe')])
  const text = describeScratchRoot(root, cleanup)
  assert.match(text, /after 3 attempts: EPERM, Permission denied/)
  assert.match(text, /pid 42 \(parent 7\) notifai-runtime\.exe: .*self-check --json/)
})

test('says when no process accounts for a directory that will not go away', () => {
  const cleanup = removeScratchRoot('/scratch', { attempts: 1, remove: () => { throw busy() }, holders: () => ({ processes: [] }) })
  assert.match(describeScratchRoot('/scratch', cleanup), /No running process starts from it or names it/)
  const unlisted = removeScratchRoot('/scratch', { attempts: 1, remove: () => { throw busy() }, holders: () => ({ error: 'timed out' }) })
  assert.match(describeScratchRoot('/scratch', unlisted), /Could not list the processes holding it: timed out/)
})

// Windows matches a command line that names the directory; elsewhere lsof
// reports the open file.
test('finds a live process holding a file under the directory', { skip: process.platform !== 'win32' && !lsofAvailable() }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-scratch-'))
  const held = path.join(root, 'held')
  writeFileSync(held, '')
  const child = spawn(process.execPath, ['-e', 'require("fs").openSync(process.argv[1], "r"); console.log("ready"); setInterval(() => {}, 1000)', held],
    { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    await once(child.stdout, 'data')
    const holders = scratchRootHolders(root)
    assert.ok(holders.processes.some(holder => holder.pid === child.pid), JSON.stringify(holders))
  } finally { child.kill() }
})

function lsofAvailable() {
  try { execFileSync('lsof', ['-v'], { stdio: 'ignore' }); return true } catch { return false }
}
