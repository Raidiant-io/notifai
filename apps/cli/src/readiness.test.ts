import { describe, expect, it } from 'vitest'
import { firstBlocker, readinessJson, refreshAfterMenuAction } from './readiness.js'

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
  const routed = [ready('question-routing-settings'), ready('hooks'), ready('hooks-active-session'), ready('hooks-fired')]
  type Verdict = { ok: boolean; question_routing_ready: boolean; states: Array<{ id: string; applies_here: boolean }> }
  const verdict = (readiness: Parameters<typeof readinessJson>[0]): Verdict =>
    ({ ...readinessJson(readiness), ok: firstBlocker(readiness) === null }) as Verdict

  it('reports another harness\'s gap without holding it against this one', () => {
    const grokSkill = { id: 'skill', title: 'skill', status: 'gap' as const, detail: 'outdated', harnesses: ['grok'] }
    const codexTrust = { id: 'hooks-trust', title: 'trust', status: 'gap' as const, detail: 'unapproved', harnesses: ['codex'] }
    const states = [...routed, grokSkill, codexTrust]
    expect(verdict({ states, harness: 'claude-code' })).toMatchObject({ ok: true, question_routing_ready: true,
      states: expect.arrayContaining([{ ...grokSkill, applies_here: false, technical: null, remedy: null },
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
