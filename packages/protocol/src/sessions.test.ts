import { describe, expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import {
  AccountPreferences,
  AttendanceRequest,
  CapabilityAdvertisement,
  ClaimDeliveryAttemptRequest,
  CloseRepliesRequest,
  CreateAnswerEditRequest,
  CreateSessionNoteRequest,
  DEFAULT_SEND_DELAY_SECONDS,
  PutSessionMessageAcknowledgementRequest,
  RegisterInstallationRequest,
  ReportDeliveryAttemptRequest,
  SESSION_NOTE_MAX_LENGTH,
  UpdateAccountPreferencesRequest,
} from './index.js'
import {
  buildSessionMessagesSyncEnvelope,
  buildSoundLibrarySyncEnvelope,
} from './apns.js'
import { buildFcmSessionMessagesSyncEnvelope } from './fcm.js'

describe('released clients keep their exact contract', () => {
  it('accepts the preference update released apps send and the shape older servers return', () => {
    expect(
      Value.Check(UpdateAccountPreferencesRequest, { agent_acknowledgement_text_enabled: false }),
    ).toBe(true)
    expect(Value.Check(AccountPreferences, { agent_acknowledgement_text_enabled: true })).toBe(true)
  })

  it('accepts released capability advertisements and still rejects unknown ones', () => {
    const installation = {
      installation_id: 'ins_abcdefghij',
      platform: 'android',
      display_name: 'Phone',
      app_version: '1.0.0',
    }
    expect(Value.Check(RegisterInstallationRequest, { ...installation, capabilities: ['answer'] })).toBe(
      true,
    )
    expect(Value.Check(RegisterInstallationRequest, { ...installation, capabilities: ['notes'] })).toBe(
      false,
    )
  })
})

describe('Send Delay preference', () => {
  it('defaults to five seconds and accepts only the offered choices', () => {
    expect(DEFAULT_SEND_DELAY_SECONDS).toBe(5)
    for (const seconds of [0, 3, 5, 10]) {
      expect(Value.Check(UpdateAccountPreferencesRequest, { send_delay_seconds: seconds })).toBe(true)
    }
    expect(Value.Check(UpdateAccountPreferencesRequest, { send_delay_seconds: 7 })).toBe(false)
    expect(
      Value.Check(AccountPreferences, {
        agent_acknowledgement_text_enabled: true,
        send_delay_seconds: 10,
      }),
    ).toBe(true)
  })

  it('rejects an update that changes nothing', () => {
    expect(Value.Check(UpdateAccountPreferencesRequest, {})).toBe(false)
  })
})

describe('Companion capabilities for notes and edits', () => {
  it('lets an installation advertise session notes and answer edits', () => {
    expect(Value.Check(CapabilityAdvertisement, ['answer', 'session_notes', 'answer_edits'])).toBe(true)
    expect(Value.Check(CapabilityAdvertisement, ['session_attendance'])).toBe(true)
  })
})

describe('close disposition', () => {
  it('accepts deliver and retire only, as a closed body', () => {
    expect(Value.Check(CloseRepliesRequest, { disposition: 'deliver' })).toBe(true)
    expect(Value.Check(CloseRepliesRequest, { disposition: 'retire' })).toBe(true)
    expect(Value.Check(CloseRepliesRequest, { disposition: 'expire' })).toBe(false)
    expect(Value.Check(CloseRepliesRequest, {})).toBe(false)
    expect(Value.Check(CloseRepliesRequest, { disposition: 'deliver', seq: 1 })).toBe(false)
  })
})

describe('Session Attendance exchange', () => {
  const incarnation = 'inc_0123456789ab'

  it('requires activity and message acceptance while running', () => {
    expect(
      Value.Check(AttendanceRequest, {
        incarnation,
        state: 'running',
        activity: 'idle',
        accepts_messages: true,
      }),
    ).toBe(true)
    expect(
      Value.Check(AttendanceRequest, {
        incarnation,
        generation: 3,
        state: 'running',
        activity: 'working',
        accepts_messages: false,
        message_cursor: 'c_42',
      }),
    ).toBe(true)
    expect(Value.Check(AttendanceRequest, { incarnation, state: 'running', accepts_messages: true })).toBe(
      false,
    )
  })

  it('reports an end or a withdrawal without presence detail', () => {
    expect(Value.Check(AttendanceRequest, { incarnation, generation: 2, state: 'ended' })).toBe(true)
    expect(Value.Check(AttendanceRequest, { incarnation, state: 'withdrawn' })).toBe(true)
    expect(
      Value.Check(AttendanceRequest, { incarnation, state: 'ended', activity: 'idle' }),
    ).toBe(false)
  })

  it('refuses local process identity as an incarnation', () => {
    expect(
      Value.Check(AttendanceRequest, { incarnation: '48213', state: 'withdrawn' }),
    ).toBe(false)
  })
})

describe('Delivery Attempts', () => {
  const claim = { incarnation: 'inc_0123456789ab', generation: 4 }

  it('claims a Session Message or a fenced answer under a held generation', () => {
    expect(
      Value.Check(ClaimDeliveryAttemptRequest, {
        ...claim,
        subject: { type: 'session_message', message_id: 'sm_abc' },
      }),
    ).toBe(true)
    expect(
      Value.Check(ClaimDeliveryAttemptRequest, {
        ...claim,
        subject: { type: 'answer', request_id: 'req_abc' },
      }),
    ).toBe(true)
    expect(
      Value.Check(ClaimDeliveryAttemptRequest, {
        incarnation: claim.incarnation,
        subject: { type: 'answer', request_id: 'req_abc' },
      }),
    ).toBe(false)
  })

  it('accepts writer-gone proof only as an explicit true', () => {
    const subject = { type: 'session_message', message_id: 'sm_abc' }
    expect(
      Value.Check(ClaimDeliveryAttemptRequest, { ...claim, subject, earlier_answer_writer_gone: true }),
    ).toBe(true)
    expect(
      Value.Check(ClaimDeliveryAttemptRequest, { ...claim, subject, earlier_answer_writer_gone: false }),
    ).toBe(false)
  })

  it('records an answer already written without a claim, and nothing else, after the fact', () => {
    const answer = { type: 'answer', request_id: 'req_abc' }
    expect(Value.Check(ClaimDeliveryAttemptRequest, { subject: answer, already_handed_off: true })).toBe(true)
    // Only answers, only an explicit true, and never mixed with a lease claim.
    expect(
      Value.Check(ClaimDeliveryAttemptRequest, {
        subject: { type: 'session_message', message_id: 'sm_abc' },
        already_handed_off: true,
      }),
    ).toBe(false)
    expect(Value.Check(ClaimDeliveryAttemptRequest, { subject: answer, already_handed_off: false })).toBe(false)
    expect(
      Value.Check(ClaimDeliveryAttemptRequest, { ...claim, subject: answer, already_handed_off: true }),
    ).toBe(false)
  })

  it('reports only the closed outcomes', () => {
    for (const outcome of ['handed_off', 'unconfirmed', 'released']) {
      expect(Value.Check(ReportDeliveryAttemptRequest, { outcome })).toBe(true)
    }
    expect(Value.Check(ReportDeliveryAttemptRequest, { outcome: 'acknowledged' })).toBe(false)
  })
})

describe('Session Notes', () => {
  const note = { client_message_id: 'cm_12345678', device_id: 'dev_abc' }

  it('bounds the note body and rejects whitespace-only text', () => {
    expect(Value.Check(CreateSessionNoteRequest, { ...note, body: 'Use the staging DB.' })).toBe(true)
    expect(
      Value.Check(CreateSessionNoteRequest, { ...note, body: 'x'.repeat(SESSION_NOTE_MAX_LENGTH) }),
    ).toBe(true)
    expect(
      Value.Check(CreateSessionNoteRequest, { ...note, body: 'x'.repeat(SESSION_NOTE_MAX_LENGTH + 1) }),
    ).toBe(false)
    expect(Value.Check(CreateSessionNoteRequest, { ...note, body: ' \n\t ' })).toBe(false)
  })

  it('takes the acknowledgement body shared with Notification Requests', () => {
    expect(Value.Check(PutSessionMessageAcknowledgementRequest, { text: 'Switching to staging.' })).toBe(
      true,
    )
  })
})

describe('Answer Edits', () => {
  const edit = { client_edit_id: 'ce_12345678', device_id: 'dev_abc', base_version: 'rep_1' }

  it('carries only the edited questions against a named base version', () => {
    expect(
      Value.Check(CreateAnswerEditRequest, {
        ...edit,
        answers: [{ question_id: 'q', choice_ids: ['b'] }],
      }),
    ).toBe(true)
    expect(Value.Check(CreateAnswerEditRequest, { ...edit, answers: [] })).toBe(false)
    expect(
      Value.Check(CreateAnswerEditRequest, {
        client_edit_id: edit.client_edit_id,
        device_id: edit.device_id,
        answers: [{ question_id: 'q', text: 'x' }],
      }),
    ).toBe(false)
  })
})

describe('Session Message sync push', () => {
  it('is a silent APNs background push distinct from the sound-library sync', () => {
    expect(buildSessionMessagesSyncEnvelope()).toEqual({
      payload: { aps: { 'content-available': 1 }, notifai: { sync: 'session_messages' } },
      priority: 5,
      pushType: 'background',
    })
    expect(buildSessionMessagesSyncEnvelope()).not.toEqual(buildSoundLibrarySyncEnvelope())
  })

  it('is a silent normal-priority FCM data message', () => {
    expect(buildFcmSessionMessagesSyncEnvelope()).toEqual({
      data: { notifai: JSON.stringify({ schema_version: 1, sync: 'session_messages' }) },
      priority: 'NORMAL',
    })
  })
})
