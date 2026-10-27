import { describe, expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import { NotificationDraft, NotificationDraftView } from './notification.js'
import { AgentAcknowledgementView, ReplyAnswerView, ReplyView } from './api.js'
import { AnswerVersionView, SessionMessageView } from './sessions.js'
import { NotificationHistoryItem } from './history.js'

const acknowledgement = { text: '', created_at: 'time', future: true }
const answer = { question_id: 'opaque / question', choice_ids: ['opaque / choice'], text: null, future: true }
const reply = { reply_id: 'opaque', client_reply_id: 'client', seq: 1, delivery_id: null,
  device_id: null, device_name: '', text: '', answers: [answer], source: null, created_at: 'time', future: true }
const version = { origin: 'companion', provenance: null, base_version: null, version_id: 'v', source: 'reply',
  status: 'current', not_delivered_reason: null, answers: [answer], text: '', device_id: null,
  created_at: 'time', agent_acknowledgement: acknowledgement, future: true }
const draft = {
  schema_version: 1, kind: 'question', project: 'opaque / project',
  lifecycle: { tier: 'new', future: true },
  source: { session_id: 'opaque / session', session_label: '', session_label_source: 'semantic',
    session_label_previous_source: 'fallback', harness: '', branch: '', worktree: '', future: true },
  presentation: { title: '', summary: 'old\nsummary', body: '', media: [{ media_id: 'opaque', alt: '', future: true }], future: true },
  targets: { mode: 'selected', device_ids: ['opaque'], future: true },
  delivery: { ttl_seconds: 1, collapse_key: '', future: true },
  reply: { expires_in_seconds: 1, questions: [{ id: 'opaque', text: '', multi: true,
    choices: [{ id: 'opaque', label: '', description: '', recommended: true, future: true }], future: true }] },
  platform: { ios: { sound: '', badge: 0, thread_id: '', category: null, interruption_level: 'active',
    relevance_score: 0, target_content_id: '', custom_data: { key: '' }, future: true },
    macos: { sound: null }, android: { sound: '', thread_id: null, custom_data: { key: '' } },
    windows: { sound: '' }, linux: { sound: null }, future: true },
  future: true,
}
const history = { request_id: 'r', revision: 'r', accepted_at: 'time', native_expires_at: 'time', retained_until: 'time',
  insertable: true, has_body: false, draft, project_name: null, delivery_id: null, reply_expires_at: null,
  retired_at: null, retirement: null, read_at: null, agent_acknowledgement_required: false,
  latest_reply: reply, agent_acknowledgement: acknowledgement, answer_versions: [version] }
const message = { message_id: 'm', session_id: 's', client_message_id: 'c', device_id: null, state: 'accepted',
  not_delivered_reason: 'future_reason', agent_acknowledgement_text_required: false, agent_acknowledgement: acknowledgement,
  created_at: 'time', handed_off_at: null, revision: 'r', kind: 'answer_edit', request_id: 'r', answers: [answer], text: '' }

function replacing(value: unknown, path: string[], replacement: unknown): unknown {
  if (!path.length) return replacement
  if (Array.isArray(value)) return value.map((entry, index) => String(index) === path[0] ? replacing(entry, path.slice(1), replacement) : entry)
  if (typeof value !== 'object' || value === null) throw new Error('Invalid test path')
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === path[0] ? replacing(entry, path.slice(1), replacement) : entry]))
}

describe('deep retained output schemas', () => {
  it('preserves additive retained data without using submission policy', () => {
    expect(Value.Check(NotificationDraft, draft)).toBe(false)
    expect(Value.Check(NotificationDraftView, draft)).toBe(true)
    expect(Value.Check(NotificationHistoryItem, history)).toBe(true)
    expect(Value.Check(SessionMessageView, message)).toBe(true)
  })
  it.each([
    'presentation', 'presentation.title', 'presentation.summary', 'presentation.body', 'presentation.media',
    'presentation.media.0', 'presentation.media.0.media_id', 'presentation.media.0.alt',
    'source', 'source.session_id', 'source.session_label', 'source.harness', 'source.branch', 'source.worktree',
    'source.session_label_source', 'source.session_label_previous_source', 'project', 'kind', 'schema_version',
    'lifecycle', 'lifecycle.tier', 'targets', 'targets.mode', 'targets.device_ids', 'targets.device_ids.0',
    'delivery', 'delivery.ttl_seconds', 'delivery.collapse_key', 'reply', 'reply.expires_in_seconds',
    'reply.questions', 'reply.questions.0', 'reply.questions.0.id', 'reply.questions.0.text', 'reply.questions.0.multi',
    'reply.questions.0.choices', 'reply.questions.0.choices.0', 'reply.questions.0.choices.0.id',
    'reply.questions.0.choices.0.label', 'reply.questions.0.choices.0.description', 'reply.questions.0.choices.0.recommended',
    'platform', 'platform.ios', 'platform.ios.sound', 'platform.ios.badge', 'platform.ios.thread_id',
    'platform.ios.category', 'platform.ios.interruption_level', 'platform.ios.relevance_score',
    'platform.ios.target_content_id', 'platform.ios.custom_data', 'platform.ios.custom_data.key',
    'platform.macos', 'platform.android', 'platform.android.sound', 'platform.android.thread_id',
    'platform.android.custom_data', 'platform.android.custom_data.key', 'platform.windows', 'platform.windows.sound',
    'platform.linux', 'platform.linux.sound',
  ])('rejects malformed draft %s', path => {
    expect(Value.Check(NotificationDraftView, replacing(draft, path.split('.'), ['presentation.media', 'targets.device_ids', 'reply.questions', 'reply.questions.0.choices'].includes(path) ? {} : []))).toBe(false)
  })
  it.each([
    ['reply_id'], ['seq'], ['delivery_id'], ['device_id'], ['device_name'], ['text'], ['source'], ['created_at'],
    ['answers', '0'], ['answers', '0', 'question_id'], ['answers', '0', 'choice_ids', '0'], ['answers', '0', 'text'],
  ])('rejects malformed reply %j', (...path) => {
    expect(Value.Check(ReplyView, replacing(reply, path, {}))).toBe(false)
  })
  it.each(Object.keys(version).filter(key => key !== 'future'))('rejects malformed answer version %s', key => {
    expect(Value.Check(AnswerVersionView, { ...version, [key]: 5 })).toBe(false)
  })
  it.each(['text', 'created_at'])('requires acknowledgement %s', key => {
    expect(Value.Check(AgentAcknowledgementView, Object.fromEntries(Object.entries(acknowledgement).filter(([field]) => field !== key)))).toBe(false)
  })
  it('requires every answer field and rejects partial nested versions', () => {
    for (const key of ['question_id', 'choice_ids', 'text']) {
      expect(Value.Check(ReplyAnswerView, Object.fromEntries(Object.entries(answer).filter(([field]) => field !== key)))).toBe(false)
    }
    expect(Value.Check(AnswerVersionView, { ...version, agent_acknowledgement: {} })).toBe(false)
    expect(Value.Check(AnswerVersionView, { ...version, answers: [{}] })).toBe(false)
    expect(Value.Check(SessionMessageView, { ...message, answers: [{}] })).toBe(false)
    expect(Value.Check(NotificationHistoryItem, { ...history, latest_reply: { ...reply, client_reply_id: undefined } })).toBe(false)
  })
  it('retains optional metadata, opaque IDs, unknown reasons and harness versions', () => {
    expect(Value.Check(AnswerVersionView, { ...version, origin: 'harness', provenance: 'agent-reported', status: 'presented', not_delivered_reason: 'future_reason' })).toBe(true)
    expect(Value.Check(NotificationHistoryItem, { ...history, answer_versions: undefined, dismissed_at: undefined })).toBe(true)
    expect(Value.Check(SessionMessageView, { ...message, kind: 'note', request_id: null, body: '' })).toBe(true)
  })
})
