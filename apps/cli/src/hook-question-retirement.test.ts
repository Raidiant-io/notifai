import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import { drainRetirements, finalizeReplies, parkForRetirement } from './hook-question-retirement.js'
import { readSessionState } from './hook-session-state.js'
import type { PendingQuestion } from './hook-types.js'

function delivered(requestId: string): PendingQuestion {
  return { question_id: `q_${requestId}`, question: 'Which option?', summary: 'Which option?',
    request_id: requestId, collapse_key: `c_${requestId}`, device_ids: ['dev_1'] } as PendingQuestion
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function isolatedEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-retirement-'))
  roots.push(root)
  return { HOME: root, XDG_STATE_HOME: root }
}

describe('retiring a delivered question', () => {
  it('tells the service how the question ended, so a withdrawn one never reads as answered elsewhere', async () => {
    const env = isolatedEnv()
    const session = `retire-${Date.now()}`
    // Esc or "Chat about this" on Claude Code's picker: nobody answered.
    parkForRetirement(session, env, delivered('req_withdrawn'), 'expired')
    // Answered in the agent's own conversation.
    parkForRetirement(session, env, delivered('req_native'), 'answered_elsewhere')
    // Answered on a device: the service already knows.
    parkForRetirement(session, env, delivered('req_device'), 'answered')
    const closeReplies = vi.fn(async (requestId: string) => ({ request_id: requestId, replies: [] }))

    const retired = await drainRetirements({ client: { closeReplies } as unknown as ApiClient, config: {} as never }, session, env)

    expect(retired).toEqual(['req_withdrawn', 'req_native', 'req_device'])
    expect(closeReplies.mock.calls).toEqual([
      ['req_withdrawn', 'retire', 'expired'],
      ['req_native', 'retire', 'answered_elsewhere'],
      ['req_device', 'retire', undefined],
    ])
  })

  it.each([
    ['a definite missing request', new ApiCallError(404, 'not_found', 'No such request'), true],
    ['a network error', new NetworkError('offline'), false],
    ['an unclassified 404', new ApiCallError(404, 'internal_error', 'Unknown response'), false],
    ['a non-404 not_found', new ApiCallError(503, 'not_found', 'Unavailable'), false],
    ['an authorization error', new ApiCallError(403, 'forbidden', 'Access denied'), false],
  ])('reconciles retirement after %s without losing retryable debt', async (_label, error, terminal) => {
    const env = isolatedEnv()
    parkForRetirement('retiring', env, delivered('req_missing'), 'expired')
    const closeReplies = vi.fn().mockRejectedValue(error)
    const ctx = { client: { closeReplies } as unknown as ApiClient, config: {} as never }
    expect(await drainRetirements(ctx, 'retiring', env)).toEqual(terminal ? ['req_missing'] : [])
    expect(readSessionState('retiring', env).retiring ?? []).toHaveLength(terminal ? 0 : 1)
    await drainRetirements(ctx, 'retiring', env)
    expect(closeReplies).toHaveBeenCalledTimes(terminal ? 1 : 2)
  })

  it('never treats a missing request as a successful answer-delivery fence', async () => {
    const closeReplies = vi.fn().mockRejectedValue(new ApiCallError(404, 'not_found', 'No such request'))
    expect(await finalizeReplies({ client: { closeReplies } as unknown as ApiClient, config: {} as never },
      'req_missing', 'deliver')).toBeNull()
  })
})
