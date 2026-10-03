import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NativeQueueNotSent, type QueueControl } from './codex-queue-control.js'
import { beginSessionIncarnation, lifecycleStamp, markSessionEnded, updateSessionState } from './hook-session-state.js'
import { currentProcessIdentity } from './process-identity.js'
import { admitInputWake, detachInputWakes, electInputWake, observeInputWake, readInputWakes, reconcileInputWakes, recoverUncertainInputWake } from './session-input-wakes.js'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { force: true, recursive: true }) })
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-owned-wakes-')); roots.push(root)
  const scope = { sessionId: 'test', env: { XDG_STATE_HOME: root } }
  const incarnation = beginSessionIncarnation(scope.sessionId, scope.env, { stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()! })
  const owner = { key: incarnation.key, incarnation: incarnation.incarnation, generation: null }
  let pending = ['answer:A:revision1']
  let working = false
  let adds = 0
  const queue = new Map<string, { token: string; text: string }>()
  const deletes: string[] = []
  const control: QueueControl = {
    namespace: 'test-native-home',
    threadId: scope.sessionId,
    add: async (token, text) => { const id = 'native-' + ++adds; queue.set(id, { token, text }); return id },
    find: async (token, text) => {
      const matches = [...queue].filter(([, value]) => value.token === token)
      return matches.length === 0 ? 'absent' : matches.length === 1 && matches[0]![1].text === text ? { id: matches[0]![0] } : 'ambiguous'
    },
    remove: async id => { deletes.push(id); return queue.delete(id) },
    close: () => {},
  }
  const opts = { ...scope, owner, namespace: control.namespace, pendingIds: () => pending,
    mayWake: () => !working, text: (token: string) => 'transport-test:' + token }
  return { scope, owner, control, opts, queue, deletes, adds: () => adds,
    pending: (ids: string[]) => { pending = ids }, working: (v: boolean) => { working = v },
    elect: () => electInputWake(opts),
    admit: (token: string, backend = control) => admitInputWake({ ...opts, token, control: backend }),
    detach: () => detachInputWakes({ ...scope, pendingIds: () => pending }),
    state: () => readInputWakes(scope),
  }
}

it('serializes election and prevents admission after a new prompt or input drain', async () => {
  const f = fixture(); const a = f.elect()!
  expect(f.elect()).toBeNull()
  f.working(true)
  await f.admit(a.token)
  expect(f.adds()).toBe(0)
  f.working(false)
  const b = f.elect()!
  f.pending([])
  await f.admit(b.token)
  expect(f.adds()).toBe(0)
  expect(f.state().every(a => a.phase === 'cancelled')).toBe(true)
})

it('retains a late add receipt after detach and never deletes a newer wake', async () => {
  const f = fixture(); const a = f.elect()!
  let resolve!: (id: string) => void
  const sending = f.admit(a.token, { ...f.control, add: async (token, text) => {
    const id = await f.control.add(token, text)
    return new Promise<string>(done => { resolve = () => done(id) })
  } })
  await Promise.resolve(); await Promise.resolve()
  f.pending([]); f.detach()
  f.pending(['note:B']); const b = f.elect()!
  await f.admit(b.token)
  resolve('unused'); await sending
  expect(f.state().find(v => v.token === a.token)).toMatchObject({ detached: true, nativeId: 'native-1', phase: 'accepted' })
  await reconcileInputWakes(f.scope, f.control)
  await reconcileInputWakes(f.scope, f.control)
  observeInputWake(f.scope, a.token)
  expect(f.deletes).toEqual(['native-1'])
  expect([...f.queue.keys()]).toEqual(['native-2'])
  expect(f.state().find(v => v.token === b.token)).toMatchObject({ detached: false, phase: 'accepted' })
})

it('recovers a lost accepted receipt from durable intent without a second add', async () => {
  const f = fixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, add: async (token, text) => {
    await f.control.add(token, text)
    throw new Error('receipt lost after acceptance')
  } })
  expect(f.state()[0]!.phase).toBe('unknown')
  f.pending([]); f.detach()
  // A fresh function invocation reads the persisted attempt; no closure-held ID.
  await reconcileInputWakes({ ...f.scope }, { ...f.control })
  expect(f.adds()).toBe(1)
  expect(f.queue.size).toBe(0)
  expect(f.state()[0]!.phase).toBe('cancelled')
})

it('keeps absent uncertain writes unresolved and old observations cannot clear new work', async () => {
  const f = fixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, add: async (token, text) => {
    const id = await f.control.add(token, text); f.queue.delete(id)
    throw new Error('dequeued before receipt')
  } })
  await reconcileInputWakes(f.scope, f.control)
  expect(f.state()[0]!.phase).toBe('unknown')
  expect(f.elect()).toBeNull()
  f.pending(['note:B']); f.detach(); const b = f.elect()!
  await f.admit(b.token)
  observeInputWake(f.scope, a.token)
  expect(f.state().find(v => v.token === b.token)).toMatchObject({ phase: 'accepted', detached: false })
  expect(f.adds()).toBe(2)
})

it('does not turn delete-absent into cancelled or disturb unrelated queue items', async () => {
  const f = fixture(); const a = f.elect()!
  await f.admit(a.token)
  f.queue.delete('native-1')
  f.queue.set('human-control', { token: 'unrelated', text: 'independent work' })
  f.pending([]); f.detach()
  await reconcileInputWakes(f.scope, f.control)
  expect(f.state()[0]).toMatchObject({ phase: 'accepted', detached: true })
  expect(f.queue.has('human-control')).toBe(true)
})

it('refuses ambiguous token matches and a different backend namespace', async () => {
  const f = fixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, add: async () => { throw new Error('unknown') } })
  f.queue.set('one', { token: a.token, text: a.text }); f.queue.set('two', { token: a.token, text: a.text })
  f.pending([]); f.detach()
  await reconcileInputWakes(f.scope, f.control)
  await reconcileInputWakes(f.scope, { ...f.control, namespace: 'other-home' })
  expect(f.deletes).toEqual([])
  expect(f.state()[0]!.phase).toBe('unknown')
})

it('fences a changed owner before native admission', async () => {
  const f = fixture(); const a = f.elect()!
  markSessionEnded(f.scope.sessionId, f.scope.env, Date.now())
  await f.admit(a.token)
  expect(f.adds()).toBe(0)
})


it('reads current pending input when an old drain runs after a newer election', async () => {
  const f = fixture(); const a = f.elect()!
  await f.admit(a.token)
  f.pending([]); f.detach()
  // The old drain has been scheduled but has not taken the state lock yet.
  const delayedDrain = f.detach
  f.pending(['note:B']); const b = f.elect()!
  await f.admit(b.token)
  delayedDrain()
  await reconcileInputWakes(f.scope, f.control)
  expect(f.deletes).toEqual(['native-1'])
  expect(f.state().find(v => v.token === b.token)).toMatchObject({ detached: false, phase: 'accepted' })
})

it('allows fresh election after a positively unsent write, but not an uncertain one', async () => {
  const f = fixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, add: async () => { throw new NativeQueueNotSent('closed before send') } })
  expect(f.state()[0]!.phase).toBe('cancelled')
  const b = f.elect()!
  expect(b).not.toBeNull()
  await f.admit(b.token, { ...f.control, add: async () => { throw new Error('connection lost') } })
  await reconcileInputWakes(f.scope, f.control)
  expect(f.elect()).toBeNull()
  expect(f.adds()).toBe(0)
})

it('refuses a control associated with another thread in the same home', async () => {
  const f = fixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, threadId: 'another-thread' })
  expect(f.adds()).toBe(0)
  const b = f.elect()!
  await f.admit(b.token)
  f.pending([]); f.detach()
  await reconcileInputWakes(f.scope, { ...f.control, threadId: 'another-thread' })
  expect(f.deletes).toEqual([])
})

it('retires a prepared attempt after owner replacement even while the writer lives', async () => {
  const f = fixture(); f.elect()
  beginSessionIncarnation(f.scope.sessionId, f.scope.env, { stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()!, openclawGeneration: 'replacement' })
  await reconcileInputWakes(f.scope, f.control)
  expect(f.state()[0]).toMatchObject({ phase: 'cancelled', detached: true })
  expect(f.adds()).toBe(0)
})


it('lets a genuinely new revision schedule once despite older uncertain input', async () => {
  const f = fixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, add: async () => { throw new Error('unknown') } })
  f.pending(['answer:A:revision1', 'note:B'])
  const b = f.elect()!
  expect(b).not.toBeNull()
  await f.admit(b.token)
  expect(f.elect()).toBeNull()
  observeInputWake(f.scope, a.token)
  expect(f.state().find(v => v.token === b.token)).toMatchObject({ detached: false, phase: 'accepted' })
})

it('bounds detached cleanup retention, per-pass work and repeated checks', async () => {
  const f = fixture()
  for (let n = 0; n < 75; n++) {
    f.pending(['revision:' + n]); const a = f.elect()!
    await f.admit(a.token, { ...f.control, add: async () => { throw new Error('unknown') } })
    f.pending([]); f.detach()
  }
  expect(f.state()).toHaveLength(64)
  let checks = 0
  const control = { ...f.control, find: async () => { checks++; return 'absent' as const } }
  await reconcileInputWakes(f.scope, control, 1000)
  expect(checks).toBe(8)
  // Next pass rotates to untouched records, and then observes backoff.
  for (let n = 0; n < 10; n++) await reconcileInputWakes(f.scope, control, 1000)
  expect(checks).toBe(64)
  expect(f.state().every(a => a.phase === 'unknown')).toBe(true)
  await reconcileInputWakes(f.scope, control, 3000)
  expect(checks).toBe(72)
})


function recoveryFixture() {
  const f = fixture()
  let now = 1_000
  const native = { file: '/native/test', identity: 'device:inode', size: 200,
    latest: { id: 'turn-A', offset: 100, ended: true }, positions: new Map<string, number>() }
  return { ...f, native, advance: (ms: number) => { now += ms },
    recover: (control = f.control) => recoverUncertainInputWake({ ...f.opts, control,
      native: () => native, monotonic: () => now }) }
}

it('permits only one replacement after sustained fresh idle, including a restart', async () => {
  const f = recoveryFixture(); const a = f.elect()!
  const unknown = { ...f.control, add: async () => { throw new Error('unknown') } }
  await f.admit(a.token, unknown)
  expect(await f.recover()).toBeNull()
  for (let n = 0; n < 14; n++) { f.advance(2000); expect(await f.recover({ ...f.control })).toBeNull() }
  f.advance(2000); const b = (await f.recover({ ...f.control }))!
  expect(b).not.toBeNull()
  await f.admit(b.token, unknown)
  for (let n = 0; n < 20; n++) { f.advance(2000); expect(await f.recover({ ...f.control })).toBeNull() }
  f.pending([]); f.detach(); f.pending(['answer:A:revision1'])
  const c = f.elect()!; await f.admit(c.token, unknown)
  for (let n = 0; n < 20; n++) { f.advance(2000); expect(await f.recover()).toBeNull() }
  // The old observation cannot settle or erase any later attempt.
  observeInputWake(f.scope, a.token)
  expect(f.state().find(v => v.token === c.token)?.phase).toBe('unknown')
  f.pending(['answer:A:revision1', 'note:B']); expect(f.elect()).not.toBeNull()
})

it('requires a truly later completion, not cached completion or unrelated growth', async () => {
  const f = recoveryFixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, add: async () => { throw new Error('unknown') } })
  expect(await f.recover()).toBeNull()
  f.advance(2000); f.native.size = 250
  expect(await f.recover()).toBeNull()
  f.native.latest = { id: 'turn-B', offset: 250, ended: false }; f.native.size = 300
  f.advance(2000); expect(await f.recover()).toBeNull()
  f.native.latest.ended = true; f.native.size = 400
  f.advance(2000); const b = await f.recover()
  expect(b).not.toBeNull()
  expect(await f.recover()).toBeNull()
  expect(f.state().find(v => v.token === a.token)).toMatchObject({ detached: true, phase: 'unknown' })
})

it('denies replacement after transcript replacement or owner loss', async () => {
  const f = recoveryFixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, add: async () => { throw new Error('unknown') } })
  await f.recover()
  f.native.identity = 'replacement'
  f.native.latest = { id: 'turn-B', offset: 250, ended: true }; f.native.size = 300
  for (let n = 0; n < 20; n++) { f.advance(2000); expect(await f.recover()).toBeNull() }
  f.native.identity = 'device:inode'
  markSessionEnded(f.scope.sessionId, f.scope.env, Date.now())
  expect(await f.recover()).toBeNull()
})

it('resets the sustained-idle interval after a read gap and preserves exact queued intent', async () => {
  const f = recoveryFixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, add: async () => { throw new Error('unknown') } })
  await f.recover(); f.advance(31000)
  expect(await f.recover()).toBeNull()
  f.queue.set('late-native-id', { token: a.token, text: a.text })
  for (let n = 0; n < 20; n++) { f.advance(2000); expect(await f.recover()).toBeNull() }
  expect(f.state().find(v => v.token === a.token)?.nativeId).toBe('late-native-id')
})


it('coalesces a fresh revision behind an accepted wake without another enqueue', async () => {
  const f = fixture(); const a = f.elect()!; await f.admit(a.token)
  f.pending(['answer:A:revision1', 'note:B'])
  expect(f.elect()).toBeNull()
  f.pending(['note:B']); f.detach()
  expect(f.state().find(v => v.token === a.token)).toMatchObject({ detached: false, inputIds: ['answer:A:revision1', 'note:B'] })
  expect(f.adds()).toBe(1)
})

it('dead sending writers do not exhaust admission capacity for new input', () => {
  const f = fixture(); const a = f.elect()!
  updateSessionState(f.scope.sessionId, f.scope.env, state => ({ ...state,
    input_wake_attempts: Array.from({ length: 8 }, (_, n) => ({ ...a, token: 'old-' + n,
      phase: 'sending', detached: true, writer: { pid: 2147483647, start: 'gone' } })) }))
  f.pending(['note:new'])
  expect(f.elect()).not.toBeNull()
})

it('unknown pending state does not erase wake ownership or admit another write', async () => {
  const f = fixture(); const a = f.elect()!; await f.admit(a.token)
  detachInputWakes({ ...f.scope, pendingIds: () => null })
  expect(f.state()[0]?.detached).toBe(false)
  expect(electInputWake({ ...f.opts, pendingIds: () => null })).toBeNull()
})


it('does not replace from stale absence after a concurrent reconciler records acceptance', async () => {
  const f = recoveryFixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, add: async () => { throw new Error('unknown') } })
  await f.recover()
  f.native.latest = { id: 'turn-B', offset: 250, ended: true }; f.native.size = 300
  const recovery = await f.recover({ ...f.control, find: async () => {
    updateSessionState(f.scope.sessionId, f.scope.env, state => ({ ...state,
      input_wake_attempts: state.input_wake_attempts!.map(v => v.token === a.token ? { ...v, nativeId: 'found-concurrently', phase: 'accepted' } : v) }))
    return 'absent'
  } })
  expect(recovery).toBeNull()
  expect(f.state()[0]).toMatchObject({ detached: false, nativeId: 'found-concurrently' })
})

it('rejects transcript truncation below its last observation even above the baseline', async () => {
  const f = recoveryFixture(); const a = f.elect()!
  await f.admit(a.token, { ...f.control, add: async () => { throw new Error('unknown') } })
  await f.recover()
  f.advance(2000); f.native.size = 500; await f.recover()
  f.advance(2000); f.native.size = 300; f.native.latest = { id: 'turn-B', offset: 250, ended: true }
  expect(await f.recover()).toBeNull()
})
