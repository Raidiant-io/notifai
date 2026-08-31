import { describe, expect, it } from 'vitest'
import { readinessJson, refreshAfterMenuAction } from './readiness.js'

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
        },
      ],
    }) as { question_routing_ready: boolean; direct_wake_ready: boolean }

    expect(result.question_routing_ready).toBe(true)
    expect(result.direct_wake_ready).toBe(false)
  })
})
