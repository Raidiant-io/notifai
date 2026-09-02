/** Question history, inspection, and atomic live-question state changes. */
import type { QuestionT, SourceContextT } from '@raidiant/notifai-protocol'
import {
  findOwningSession,
  pendingList,
  readSessionState,
  updateSessionState,
} from './hook-session-state.js'
import type {
  PendingQuestion,
  QuestionDeliveryState,
  QuestionHistoryEntry,
  QuestionTerminalState,
  SessionState,
} from './hook-types.js'
import { inferInvocationContext } from './invocation-context.js'
export interface QuestionStateView {
  question_id: string
  state: QuestionDeliveryState
  /** Null means a frozen submission may or may not have crossed the service boundary. */
  submitted: boolean | null
  request_id: string | null
  frozen_request_id: string | null
}

export type QuestionStateLookup =
  | { found: true; session_id: string; question: QuestionStateView }
  | { found: false; ambiguous: boolean }

/** Keep immutable session grouping while replacing per-event Git location authoritatively. */
export function sourceContextAtHookEvent(
  source: SourceContextT | undefined,
  cwd: string | undefined,
): SourceContextT | undefined {
  const invocation = cwd === undefined ? null : inferInvocationContext(cwd)
  const current: SourceContextT = {
    ...(source?.session_id !== undefined ? { session_id: source.session_id } : {}),
    ...(source?.session_label !== undefined ? { session_label: source.session_label } : {}),
    ...(source?.harness !== undefined ? { harness: source.harness } : {}),
    ...(invocation?.branch !== undefined ? { branch: invocation.branch } : {}),
    ...(invocation?.worktree !== undefined ? { worktree: invocation.worktree } : {}),
  }
  return Object.keys(current).length === 0 ? undefined : current
}

export function summarizeRequestIds(entries: readonly PendingQuestion[]): {
  ids: string[]
  display: string
} {
  const ids = entries.flatMap((entry) =>
    entry.request_id === undefined ? [] : [entry.request_id],
  )
  return { ids, display: ids.join(', ') }
}

const QUESTION_HISTORY_CAP = 50

type QuestionIdentity = Pick<PendingQuestion, 'question_id' | 'request_id' | 'submission'>

/** Keep a bounded, content-free map from local identity to its terminal state. */
export function rememberQuestionState(
  current: SessionState,
  question: QuestionIdentity,
  state: QuestionTerminalState,
): SessionState {
  if (question.question_id === undefined) return current
  const existing = (current.question_history ?? []).find(
    (entry) => entry.question_id === question.question_id,
  )
  const terminalState =
    existing?.state === 'withdrawn' || existing?.state === 'answered'
      ? existing.state
      : state === 'answered'
        ? 'answered'
        : state
  const requestId = question.request_id ?? existing?.request_id
  const frozenRequestId =
    requestId === undefined
      ? question.submission?.request_id ?? existing?.frozen_request_id
      : undefined
  const record: QuestionHistoryEntry = {
    question_id: question.question_id,
    state: terminalState,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(frozenRequestId === undefined ? {} : { frozen_request_id: frozenRequestId }),
  }
  const history = [
    ...(current.question_history ?? []).filter(
      (entry) => entry.question_id !== question.question_id,
    ),
    record,
  ].slice(-QUESTION_HISTORY_CAP)
  return { ...current, question_history: history }
}

function pendingQuestionView(entry: PendingQuestion): QuestionStateView | null {
  if (entry.question_id === undefined) return null
  if (entry.request_id !== undefined) {
    return {
      question_id: entry.question_id,
      state: 'live',
      submitted: true,
      request_id: entry.request_id,
      frozen_request_id: null,
    }
  }
  if (entry.submission !== undefined) {
    return {
      question_id: entry.question_id,
      state: 'frozen',
      submitted: null,
      request_id: null,
      frozen_request_id: entry.submission.request_id,
    }
  }
  return {
    question_id: entry.question_id,
    state: 'local',
    submitted: false,
    request_id: null,
    frozen_request_id: null,
  }
}

/** Read one stable local question identity without minting or submitting anything. */
export function inspectQuestionState(
  questionId: string,
  env: NodeJS.ProcessEnv,
): QuestionStateLookup {
  const owner = findOwningSession(questionId, env)
  if (owner.ambiguous || owner.sessionId === null) {
    return { found: false, ambiguous: owner.ambiguous }
  }
  const state = readSessionState(owner.sessionId, env)
  const pending = pendingList(state).find((entry) => entry.question_id === questionId)
  const pendingView = pending === undefined ? null : pendingQuestionView(pending)
  if (pendingView !== null) {
    return { found: true, session_id: owner.sessionId, question: pendingView }
  }
  const accepted = state.accepted?.answers.find(
    ({ pending: entry }) => entry.question_id === questionId,
  )?.pending
  if (accepted?.question_id !== undefined) {
    return {
      found: true,
      session_id: owner.sessionId,
      question: {
        question_id: accepted.question_id,
        state: 'answered',
        submitted: true,
        request_id: accepted.request_id ?? null,
        frozen_request_id: null,
      },
    }
  }
  const retiring = (state.retiring ?? []).find((entry) => entry.question_id === questionId)
  if (retiring?.question_id !== undefined) {
    return {
      found: true,
      session_id: owner.sessionId,
      question: {
        question_id: retiring.question_id,
        state: retiring.state === 'answered' ? 'answered' : 'retired',
        submitted: true,
        request_id: retiring.request_id,
        frozen_request_id: null,
      },
    }
  }
  const history = (state.question_history ?? []).find(
    (entry) => entry.question_id === questionId,
  )
  if (history !== undefined) {
    return {
      found: true,
      session_id: owner.sessionId,
      question: {
        question_id: history.question_id,
        state: history.state,
        submitted:
          history.request_id !== undefined
            ? true
            : history.frozen_request_id !== undefined
              ? null
              : false,
        request_id: history.request_id ?? null,
        frozen_request_id: history.frozen_request_id ?? null,
      },
    }
  }
  return { found: false, ambiguous: false }
}

/** Registration identity — the convention every racing writer compares by. */
export function isSamePending(a: PendingQuestion, b: PendingQuestion): boolean {
  if (a.question_id !== undefined || b.question_id !== undefined) {
    return a.question_id !== undefined && a.question_id === b.question_id
  }
  return a.question === b.question && a.asked_at === b.asked_at
}

export function dropPendingQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  entry: PendingQuestion,
  terminalState: QuestionTerminalState = 'retired',
): void {
  updateSessionState(sessionId, env, (current) => {
    const pending = pendingList(current).filter((candidate) => !isSamePending(candidate, entry))
    const next: SessionState = { ...current }
    if (pending.length > 0) next.pending = pending
    else delete next.pending
    return rememberQuestionState(next, entry, terminalState)
  })
}

/**
 * Drop registrations that never reached a device, so a later Stop cannot push
 * them. A retirement push would be noise: there is nothing on any device to
 * withdraw. Returns the withdrawn entries in registration order.
 */
export function withdrawUnpushedQuestions(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): PendingQuestion[] {
  let withdrawn: PendingQuestion[] = []
  updateSessionState(sessionId, env, (current) => {
    const pending = pendingList(current)
    withdrawn = pending.filter((entry) => entry.request_id === undefined)
    if (withdrawn.length === 0) return current
    const remaining = pending.filter((entry) => entry.request_id !== undefined)
    const next: SessionState = { ...current }
    if (remaining.length > 0) next.pending = remaining
    else delete next.pending
    return withdrawn.reduce(
      (remembered, entry) => rememberQuestionState(remembered, entry, 'withdrawn'),
      next,
    )
  })
  return withdrawn
}

export function clearFrozenSubmission(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  entry: PendingQuestion,
): void {
  updateSessionState(sessionId, env, (current) => {
    const list = pendingList(current)
    const index = list.findIndex((candidate) => isSamePending(candidate, entry))
    if (index < 0) return current
    const next = [...list]
    const copy = { ...next[index]! }
    delete copy.submission
    next[index] = copy
    return { ...current, pending: next }
  })
}

/** The question set this pending record pushes, however it was registered. */
export function pendingQuestions(pending: PendingQuestion): QuestionT[] {
  return pending.questions ?? [{ id: 'q1', text: pending.question }]
}

/** Did any question in the set offer choices? Decides how replies combine. */
export function pendingHasChoices(pending: PendingQuestion): boolean {
  return pendingQuestions(pending).some((question) => question.choices !== undefined)
}
