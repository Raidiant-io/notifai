import { Value } from '@sinclair/typebox/value'
import { expect, it } from 'vitest'
import { isCompanionChangesPage } from './changes.js'
import { isSetupIssuesResponse, PutMachineSetupIssuesRequest } from './setup-issues.js'

const report = { key: 'codex_hooks_unapproved:abc', kind: 'codex_hooks_unapproved', harness: 'codex',
  session_ids: ['session-one'], lost: ['session_notes', 'answer_wake'], fixer: 'user_at_computer',
  params: { codex_home: '~/.codex', platform: 'darwin' } }
const view = { ...report, id: 'si_opaque', machine_id: 'mac_test', machine_name: 'Studio', severity: 'notice', since: '2026-10-28T09:14:00Z' }

it('accepts bounded snapshots and rejects oversized issues, sessions, and unsafe parameter text', () => {
  const check = (issues: unknown[]) => Value.Check(PutMachineSetupIssuesRequest, { issues })
  expect(check(Array.from({ length: 32 }, (_, index) => ({ ...report, key: `issue:${index}` })))).toBe(true)
  expect(check(Array.from({ length: 33 }, (_, index) => ({ ...report, key: `issue:${index}` })))).toBe(false)
  expect(check([{ ...report, session_ids: Array.from({ length: 100 }, (_, index) => `s${index}`) }])).toBe(true)
  expect(check([{ ...report, session_ids: Array.from({ length: 101 }, (_, index) => `s${index}`) }])).toBe(false)
  for (const codex_home of ['~/.codex\nunsafe', '~/.codex\u0000unsafe', '/' + 'a'.repeat(512)]) {
    expect(check([{ ...report, params: { codex_home } }])).toBe(false)
  }
})

it('keeps old feed envelopes valid and accepts unfamiliar issue kinds for generic rendering', () => {
  expect(isSetupIssuesResponse({ issues: [{ ...view, kind: 'future_kind', lost: ['future_job'] }] })).toBe(true)
  const page = { notifications: [], session_messages: [], presence: null, next_cursor: 'opaque', has_more: false }
  expect(isCompanionChangesPage(page)).toBe(true)
  expect(isCompanionChangesPage({ ...page, setup_issues: null })).toBe(true)
  expect(isCompanionChangesPage({ ...page, setup_issues: [view] })).toBe(true)
  expect(isCompanionChangesPage({ ...page, setup_issues: [{ ...view, severity: 'urgent' }] })).toBe(false)
})
