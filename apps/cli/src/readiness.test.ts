import { describe, expect, it } from 'vitest'
import { asInformation, firstBlocker, isReady, readinessJson, refreshAfterMenuAction } from './readiness.js'

const deliveryReady = ['cli-bin', 'credential', 'server', 'contract', 'auth', 'devices']
  .map((id) => ({ id, title: id, status: 'ready' as const, detail: 'ready' }))

describe('refreshAfterMenuAction', () => {
  it('does not re-assess after doctor, a test send, or a device list', () => {
    expect(refreshAfterMenuAction('doctor', true)).toBeNull()
    expect(refreshAfterMenuAction('test', true)).toBeNull()
    expect(refreshAfterMenuAction('devices', true)).toBeNull()
  })

  it('does not re-assess when the action changed nothing', () => {
    expect(refreshAfterMenuAction('account', false)).toBeNull()
    expect(refreshAfterMenuAction('settings', false)).toBeNull()
    expect(refreshAfterMenuAction('routing', false)).toBeNull()
    expect(refreshAfterMenuAction('setup', false)).toBeNull()
  })

  it('re-probes the service only after an action that can change it', () => {
    expect(refreshAfterMenuAction('setup', true)).toEqual(['local', 'remote'])
    expect(refreshAfterMenuAction('account', true)).toEqual(['local', 'remote'])
    expect(refreshAfterMenuAction('settings', true)).toEqual(['local'])
    expect(refreshAfterMenuAction('routing', true)).toEqual(['local'])
    expect(refreshAfterMenuAction('settings', true, { remote: true })).toEqual(['local', 'remote'])
  })
})

describe('Question Routing readiness', () => {
  it('serializes an unassessed direct-wake capability as explicit null', () => {
    const serialized = JSON.parse(JSON.stringify(readinessJson({ states: [] }))) as {
      direct_wake_ready?: boolean | null
    }

    expect(serialized).toHaveProperty('direct_wake_ready', null)
  })

  it('keeps an evidenced continuation ready when only direct wake is unavailable', () => {
    const ready = (id: string) => ({ id, title: id, status: 'ready' as const, detail: 'ready' })
    const result = readinessJson({
      states: [
        ...deliveryReady,
        ready('question-routing-settings'),
        ready('hooks'),
        ready('hooks-active-harness'),
        ready('hooks-active-session'),
        ready('hooks-adapter'),
        ready('hooks-question-admission'),
        ready('hooks-stop-shape'),
        ready('hooks-fired'),
        ready('hooks-answer-continuation'),
        {
          id: 'hooks-wake-route',
          title: 'Direct wake route',
          status: 'optional-gap' as const,
          detail: 'the held Stop continuation remains available',
          technical: { direct_wake_optional: true },
        },
      ],
    }) as { question_routing_ready: boolean; direct_wake_ready: boolean }

    expect(result.question_routing_ready).toBe(true)
    expect(result.direct_wake_ready).toBe(false)
  })

  it('fails Question Routing closed when POSIX Claude has no wake route', () => {
    const ready = (id: string) => ({ id, title: id, status: 'ready' as const, detail: 'ready' })
    const result = readinessJson({
      states: [
        ...deliveryReady,
        ready('question-routing-settings'),
        ready('hooks'),
        ready('hooks-active-harness'),
        ready('hooks-active-session'),
        ready('hooks-adapter'),
        ready('hooks-question-admission'),
        ready('hooks-stop-shape'),
        ready('hooks-fired'),
        ready('hooks-answer-continuation'),
        {
          id: 'hooks-wake-route',
          title: 'Direct wake route',
          status: 'optional-gap' as const,
          detail: 'the out-of-band waiter cannot wake this Agent Session',
        },
      ],
    }) as { question_routing_ready: boolean; direct_wake_ready: boolean }

    expect(result.question_routing_ready).toBe(false)
    expect(result.direct_wake_ready).toBe(false)
  })
})

describe('harness-scoped verdicts', () => {
  const ready = (id: string) => ({ id, title: id, status: 'ready' as const, detail: 'ready' })
  const routed = [...deliveryReady, ready('question-routing-settings'), ready('hooks'), ready('hooks-active-session'), ready('hooks-fired')]
  type Verdict = { ok: boolean; question_routing_ready: boolean; states: Array<{ id: string; applies_here: boolean }> }
  const verdict = (readiness: Parameters<typeof readinessJson>[0]): Verdict =>
    ({ ...readinessJson(readiness), ok: firstBlocker(readiness) === null }) as Verdict

  it('reports another harness\'s gap without holding it against this one', () => {
    const grokSkill = { id: 'skill', title: 'skill', status: 'gap' as const, detail: 'outdated', harnesses: ['grok'] }
    const codexTrust = { id: 'hooks-trust', title: 'trust', status: 'gap' as const, detail: 'unapproved', harnesses: ['codex'] }
    const states = [...routed, grokSkill, codexTrust]
    expect(verdict({ states, harness: 'claude-code' })).toMatchObject({ ok: true, question_routing_ready: true,
      states: expect.arrayContaining([{ ...grokSkill, applies_here: false, technical: null, remedy: null, informational: null },
        expect.objectContaining({ id: 'hooks-trust', applies_here: false })]) })
    expect(verdict({ states, harness: 'codex' })).toMatchObject({ ok: false, question_routing_ready: false })
    // With no harness to judge for, the whole machine is the subject.
    expect(verdict({ states, harness: null })).toMatchObject({ ok: false, question_routing_ready: false })
  })

  it('keeps Question Routing ready without a Codex shared app-server', () => {
    const states = [...routed, { id: 'hooks-codex-shared-server', title: 'forms', status: 'optional-gap' as const,
      detail: 'no shared Codex app-server', harnesses: ['codex'] }]
    expect(verdict({ states, harness: 'codex' }).question_routing_ready).toBe(true)
    expect(verdict({ states, harness: 'claude-code' }).question_routing_ready).toBe(true)
  })
})

describe('information that is not a gap', () => {
  const ready = (id: string) => ({ id, title: id, status: 'ready' as const, detail: 'ready' })
  const gap = (id: string) => ({ id, title: id, status: 'gap' as const, detail: 'unmet',
    remedy: { by: 'cli' as const, summary: 'undo it', command: 'notifai hooks install' } })
  const routed = [...deliveryReady, ready('question-routing-settings'), ready('hooks'), ready('hooks-fired')]

  it('carries no remedy and never blocks doctor or init', () => {
    const limit = asInformation(gap('hooks-answer-continuation'), 'harness-capability')
    expect(limit).toMatchObject({ status: 'optional-gap', informational: 'harness-capability' })
    expect(limit).not.toHaveProperty('remedy')
    const readiness = { states: [...routed, limit], harness: 'cursor' }
    expect(firstBlocker(readiness)).toBeNull()
    expect(isReady(readiness)).toBe(true)
    expect(readinessJson(readiness)).toMatchObject({
      states: expect.arrayContaining([expect.objectContaining({ id: 'hooks-answer-continuation', informational: 'harness-capability', remedy: null })]),
    })
  })

  it('judges Question Routing by what the harness can do, not by a route it lacks by design', () => {
    const limits = ['hooks-question-admission', 'hooks-answer-continuation']
      .map((id) => asInformation(gap(id), 'harness-capability'))
    expect(readinessJson({ states: [...routed, ...limits], harness: 'cursor' })).toMatchObject({ question_routing_ready: true })
    // The routes the harness does have still have to be ready.
    expect(readinessJson({ states: [...routed, ...limits, gap('hooks-stale')], harness: 'cursor' }))
      .toMatchObject({ question_routing_ready: false })
    expect(readinessJson({ states: limits, harness: 'cursor' })).toMatchObject({ question_routing_ready: false })
  })

  it('keeps questions the User turned off out of Question Routing', () => {
    const off = asInformation(gap('question-routing-settings'), 'user-choice')
    const readiness = { states: [...deliveryReady, off, ready('hooks'), ready('hooks-fired')], harness: 'claude-code' }
    expect(firstBlocker(readiness)).toBeNull()
    expect(readinessJson(readiness)).toMatchObject({ question_routing_ready: false })
  })

  it('serializes an ordinary state with informational null', () => {
    expect(readinessJson({ states: [ready('hooks')] })).toMatchObject({ states: [expect.objectContaining({ informational: null })] })
  })
})
