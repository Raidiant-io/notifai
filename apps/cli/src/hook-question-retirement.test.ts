import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from './client.js'
import { drainRetirements, parkForRetirement } from './hook-question-retirement.js'
import type { PendingQuestion } from './hook-types.js'

function delivered(requestId: string): PendingQuestion {
  return { question_id: `q_${requestId}`, question: 'Which option?', summary: 'Which option?',
    request_id: requestId, collapse_key: `c_${requestId}`, device_ids: ['dev_1'] } as PendingQuestion
}

describe('retiring a delivered question', () => {
  it('tells the service how the question ended, so a withdrawn one never reads as answered elsewhere', async () => {
    const env = { ...process.env }
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
})
