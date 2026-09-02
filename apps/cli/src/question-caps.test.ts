import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_LIVE_QUESTIONS, MAX_PENDING_QUESTIONS, registerQuestion } from './hook-lifecycle.js'

/**
 * `registerQuestion` decides how many questions one session may hold, and these
 * exercise it directly against a bare state directory — no harness, no server,
 * no clock. They live apart from `hooks.test.ts` because nothing here needs
 * what that file spends its setup on.
 */
const state = (): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'notifai-caps-'))
  return { HOME: dir, XDG_STATE_HOME: path.join(dir, 'state') } as NodeJS.ProcessEnv
}

describe('how many questions one session may hold', () => {
  it('stops an agent registering a fifth question nobody has asked yet', () => {
    const env = state()
    for (let i = 0; i < MAX_PENDING_QUESTIONS; i += 1) {
      registerQuestion('loop', env, { question: `Q${i}?` })
    }
    expect(() => registerQuestion('loop', env, { question: 'One more?' })).toThrow(
      /already waiting to be asked/,
    )
  })

  it('does not count a question the user simply has not answered yet', () => {
    // An answer stays accepted for a day. Counting questions already on the
    // user's devices against the loop guard would let a patient user stop the
    // agent from asking anything at all.
    const env = state()
    for (let i = 0; i < MAX_PENDING_QUESTIONS; i += 1) {
      registerQuestion('live', env, { question: `Asked ${i}?`, request_id: `req_${i}` })
    }
    expect(() => registerQuestion('live', env, { question: 'A new one?' })).not.toThrow()
  })

  it('still bounds what one session can put on the lock screen', () => {
    const env = state()
    for (let i = 0; i < MAX_LIVE_QUESTIONS; i += 1) {
      registerQuestion('flood', env, { question: `Asked ${i}?`, request_id: `req_${i}` })
    }
    expect(() => registerQuestion('flood', env, { question: 'One too many?' })).toThrow(
      /already open/,
    )
  })
})
