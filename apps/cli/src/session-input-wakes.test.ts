import { mkdtempSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,expect,it } from 'vitest'
import { type QueueControl } from './codex-queue-control.js'
import { beginSessionIncarnation,lifecycleStamp } from './hook-session-state.js'
import { currentProcessIdentity } from './process-identity.js'
import { admitInputWake,detachInputWakes,electInputWake,observeInputWake,readInputWakes,reconcileInputWakes } from './session-input-wakes.js'

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
