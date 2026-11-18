import { describe, expect, it } from 'vitest'
import type { AnsweredPending, PendingQuestion, SessionState } from './hook-types.js'
import { promptOpenQuestions, promptOpenQuestionsContext } from './prompt-open-questions.js'

function question(id: string, text: string, extra: Partial<PendingQuestion> = {}): PendingQuestion {
  return { question_id: id, question: text, summary: text, request_id: `req_${id}`, questions: [{ id: 'q1', text }], ...extra }
}

function answered(pending: PendingQuestion): AnsweredPending {
  return { pending, reply: { text: 'Blue' } } as AnsweredPending
}

describe('promptOpenQuestions', () => {
  it('leaves out questions whose answer is already being handed to the agent', () => {
    const open = question('q_open', 'Open?')
    const accepted = question('q_accepted', 'Accepted?')
    const delivered = question('q_delivered', 'Delivered?')
    const state = {
      pending: [open, accepted, delivered],
      accepted: { answers: [answered(accepted)] },
      delivered_answers: [answered(delivered)],
    } as unknown as SessionState
    expect(promptOpenQuestions(state).map((entry) => entry.question_id)).toEqual(['q_open'])
  })

  it('names nothing when no question is open', () => {
    expect(promptOpenQuestionsContext({})).toBeNull()
  })

  it('marks a subagent question, names the rest of a form and summarises a long backlog', () => {
    const pending = [
      question('q_form', 'First?', { questions: [{ id: 'a', text: 'First?' }, { id: 'b', text: 'Second?' }, { id: 'c', text: 'Third?' }] }),
      question('q_child', 'Child?', { asked_by: { agent_id: 'worker' } as PendingQuestion['asked_by'] }),
      ...['3', '4', '5', '6', '7'].map((n) => question(`q_${n}`, `Question ${n}?`)),
    ]
    const context = promptOpenQuestionsContext({ pending } as SessionState)!
    expect(context).toContain('- q_form, one form of 3 questions that closes as a whole. Close: `notifai close q_form`\n  - "First?"\n  - "Second?"\n  - "Third?"')
    expect(context).toContain('- q_child, asked by a subagent: "Child?"')
    expect(context).toContain('q_5')
    expect(context).not.toContain('q_6')
    expect(context).toContain('- 2 more: `notifai replies --pending --json` lists them.')
  })
})
