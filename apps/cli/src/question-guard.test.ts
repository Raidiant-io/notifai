import { describe, expect, it } from 'vitest'
import type { QuestionT } from '@raidiant/notifai-protocol'
import type { AnsweredPending, PendingQuestion, SessionState } from './hook-types.js'
import { captureCandidates, findOpenEqualQuestion, sameQuestions } from './question-guard.js'

const WHERE: QuestionT = { id: 'where', text: 'Where?', choices: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }] }

function pending(questionId: string, questions: QuestionT[] = [WHERE]): PendingQuestion {
  return { question_id: questionId, question: questions[0]!.text, summary: questions[0]!.text, questions }
}

function answered(entry: PendingQuestion): AnsweredPending {
  return { pending: entry, reply: { reply_id: 'rpl_1', seq: 1 }, replies: [] } as unknown as AnsweredPending
}

describe('the duplicate guard', () => {
  it('calls two question sets the same only when text, choice labels in order and multi-select all match', () => {
    expect(sameQuestions([WHERE], [{ ...WHERE, id: 'other', choices: WHERE.choices!.map((choice) => ({ ...choice, id: `x-${choice.id}` })) }])).toBe(true)
    // Descriptions and the recommended mark are not part of the question.
    expect(sameQuestions([WHERE], [{ ...WHERE, choices: [{ id: 'a', label: 'Staging', description: 'Safe.', recommended: true }, { id: 'b', label: 'Production' }] }])).toBe(true)
    expect(sameQuestions([WHERE], [{ ...WHERE, text: 'Where to?' }])).toBe(false)
    expect(sameQuestions([WHERE], [{ ...WHERE, choices: [WHERE.choices![1]!, WHERE.choices![0]!] }])).toBe(false)
    expect(sameQuestions([WHERE], [{ ...WHERE, choices: [...WHERE.choices!, { id: 'canary', label: 'Canary' }] }])).toBe(false)
    expect(sameQuestions([WHERE], [{ ...WHERE, multi: true }])).toBe(false)
    expect(sameQuestions([WHERE], [{ id: 'where', text: 'Where?' }])).toBe(false)
    expect(sameQuestions([{ id: 'why', text: 'Why?' }], [{ id: 'q1', text: 'Why?' }])).toBe(true)
    expect(sameQuestions([WHERE, { id: 'why', text: 'Why?' }], [WHERE])).toBe(false)
    expect(sameQuestions([WHERE, { id: 'why', text: 'Why?' }], [{ id: 'why', text: 'Why?' }, WHERE])).toBe(false)
    expect(sameQuestions(undefined, [WHERE])).toBe(false)
    expect(sameQuestions([WHERE], undefined)).toBe(false)
  })

  it('lets open and unread-answered questions capture an equal one, never a consumed, dismissed or terminated one', () => {
    const consumed = answered(pending('q_consumed'))
    const state: SessionState = {
      pending: [pending('q_open'), pending('q_dismissed'), pending('q_terminated'), pending('q_other', [{ id: 'why', text: 'Why?' }])],
      waiting_answers: [answered(pending('q_waiting'))],
      accepted: { answers: [answered(pending('q_unread'))], remaining: 0, recorded_at: 1 },
      delivered_answers: [consumed],
      codex_question_bindings: [
        { question_id: 'q_dismissed', dismissed: true },
        { question_id: 'q_terminated', terminated: true },
      ] as SessionState['codex_question_bindings'],
    }
    expect(captureCandidates(state).map((entry) => entry.question_id)).toEqual(['q_open', 'q_other', 'q_waiting', 'q_unread'])
    expect(findOpenEqualQuestion(state, [WHERE])?.question_id).toBe('q_open')
    expect(findOpenEqualQuestion({ ...state, pending: [] }, [WHERE])?.question_id).toBe('q_waiting')
    expect(findOpenEqualQuestion({ ...state, pending: [], waiting_answers: [] }, [WHERE])?.question_id).toBe('q_unread')
    // A delivered answer was consumed: the question is over, and equal text later is a new question.
    const delivered = { ...state, pending: [], waiting_answers: [],
      accepted: { answers: [consumed], remaining: 0, recorded_at: 1, delivered_at: 2, delivery_committed_at: 2 } }
    expect(captureCandidates(delivered)).toEqual([])
    expect(findOpenEqualQuestion(delivered, [WHERE])).toBeUndefined()
    expect(findOpenEqualQuestion(state, undefined)).toBeUndefined()
    expect(findOpenEqualQuestion({}, [WHERE])).toBeUndefined()
  })
})
