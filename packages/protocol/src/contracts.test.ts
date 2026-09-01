import { describe, expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import {
  AccountPreferences,
  AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
  ANDROID_CAPABILITIES_V1,
  BODY_MAX_LENGTH,
  BeginPairingRequest,
  CAPABILITIES_V1,
  CLOSED_CHOICE_BANNER_AFFORDANCE,
  DEFAULT_AGENT_ACKNOWLEDGEMENT_TEXT_ENABLED,
  defaultDeliveryPolicy,
  effectiveKind,
  estimateApnsPayloadBytes,
  estimateFcmPayloadBytes,
  IOS_CAPABILITIES_V1,
  MACOS_CAPABILITIES_V1,
  NOTIFICATION_CONTRACT_FINGERPRINT,
  PLATFORMS,
  PairingProofRequest,
  PROVIDERS,
  PutRegistrationRequest,
  REPLY_CATEGORY_ID,
  REPLY_CHOICE_CATEGORY_ID,
  REPLY_SOURCES,
  RegisterInstallationRequest,
  summarizeOverall,
  SubmitFeedbackRequest,
  SubmitNotificationRequest,
  PutAgentAcknowledgementRequest,
  UpdateAccountPreferencesRequest,
  validateDraft,
  type ListRepliesResponse,
  type NotificationDraftT,
  type ProjectView,
  type PutAgentAcknowledgementResponse,
  type SubmissionReceipt,
} from './index.js'
import {
  buildApnsEnvelope,
  buildSoundLibrarySyncEnvelope,
  collapsedChoiceAlert,
  RECEIPT_TOKEN_LENGTH,
} from './apns.js'
import { buildFcmDataEnvelope } from './fcm.js'

function draft(overrides: Partial<NotificationDraftT> = {}): NotificationDraftT {
  return {
    schema_version: 1,
    presentation: { title: 'Build finished', body: 'All checks passed.' },
    targets: { mode: 'all' },
    delivery: defaultDeliveryPolicy(),
    ...overrides,
  }
}

const projectViewFixture: ProjectView = {
  project_id: 'prj_example',
  identifier: 'example',
  display_name: 'Example',
  image_media_id: null,
  avatar_revision: 'generated:v1',
  image_url: 'https://example.test/api/v1/projects/prj_example/avatar.png',
  last_seen_at: '2026-08-28T00:00:00.000Z',
}

/** The smallest well-formed reply block: one free-text question. */
function freeTextReply(expiresInSeconds = 86400): NotificationDraftT['reply'] {
  return { expires_in_seconds: expiresInSeconds, questions: [{ id: 'q', text: 'Your call?' }] }
}

describe('Project identity contract', () => {
  it('carries a stable avatar revision separately from its URL', () => {
    expect(projectViewFixture.avatar_revision).toBe('generated:v1')
    expect(projectViewFixture.image_url).toContain('/avatar.png')
  })
})

describe('pairing ownership proof contract', () => {
  const begin = {
    machine_name: 'workstation',
    credential_hash: 'a'.repeat(64),
    poll_verifier_hash: 'b'.repeat(64),
    confirmation_hash: 'c'.repeat(64),
  }
  const proof = {
    code: 'KWQ-58C',
    confirmation_secret: 'd'.repeat(43),
  }

  it('requires a distinct confirmation verifier when pairing begins', () => {
    expect(Value.Check(BeginPairingRequest, begin)).toBe(true)
    expect(
      Value.Check(BeginPairingRequest, {
        machine_name: begin.machine_name,
        credential_hash: begin.credential_hash,
        poll_verifier_hash: begin.poll_verifier_hash,
      }),
    ).toBe(false)
    expect(Value.Check(BeginPairingRequest, { ...begin, confirmation_hash: 'c'.repeat(63) })).toBe(
      false,
    )
  })

  it('requires the canonical short code and full one-time secret on every dashboard action', () => {
    expect(Value.Check(PairingProofRequest, proof)).toBe(true)
    expect(Value.Check(PairingProofRequest, { code: proof.code })).toBe(false)
    expect(Value.Check(PairingProofRequest, { ...proof, code: 'OIQ-01I' })).toBe(false)
    expect(
      Value.Check(PairingProofRequest, { ...proof, confirmation_secret: 'd'.repeat(42) }),
    ).toBe(false)
  })
})

describe('account preference and reply capability contracts', () => {
  it('defines an explicit default-true account preference and a closed update shape', () => {
    expect(DEFAULT_AGENT_ACKNOWLEDGEMENT_TEXT_ENABLED).toBe(true)
    expect(Value.Check(AccountPreferences, { agent_acknowledgement_text_enabled: true })).toBe(true)
    expect(Value.Check(AccountPreferences, { agent_acknowledgement_text_enabled: false })).toBe(
      true,
    )
    expect(Value.Check(AccountPreferences, {})).toBe(false)
    expect(
      Value.Check(UpdateAccountPreferencesRequest, { agent_acknowledgement_text_enabled: false }),
    ).toBe(true)
    expect(
      Value.Check(UpdateAccountPreferencesRequest, {
        agent_acknowledgement_text_enabled: true,
        unknown: true,
      }),
    ).toBe(false)
    // The retired name must not survive as a silently accepted alias.
    expect(Value.Check(AccountPreferences, { agent_acknowledgements_enabled: true })).toBe(false)
  })

  it('advertises named capabilities without retaining the reply protocol integer', () => {
    const installation = {
      installation_id: 'ins_abcdefghij',
      platform: 'ios',
      display_name: 'Phone',
      app_version: '2.0.0',
    }
    expect(
      Value.Check(RegisterInstallationRequest, {
        ...installation,
        app_build: '42',
        os_version: '19.0',
        capabilities: ['answer'],
      }),
    ).toBe(true)
    expect(Value.Check(RegisterInstallationRequest, installation)).toBe(true)
    expect(
      Value.Check(RegisterInstallationRequest, { ...installation, reply_protocol_version: 2 }),
    ).toBe(false)
    expect(
      Value.Check(RegisterInstallationRequest, {
        ...installation,
        capabilities: ['answer', 'answer'],
      }),
    ).toBe(false)
    expect(
      Value.Check(RegisterInstallationRequest, {
        ...installation,
        capabilities: ['unknown'],
      }),
    ).toBe(false)
  })
})

describe('platform and provider vocabulary', () => {
  it('publishes Android and FCM as client-visible contract values', () => {
    expect(PLATFORMS).toEqual(['ios', 'macos', 'android'])
    expect(PROVIDERS).toEqual(['apns', 'fcm'])
    expect(REPLY_SOURCES).toContain('remote_input')

    expect(
      Value.Check(RegisterInstallationRequest, {
        installation_id: 'ins_android123',
        platform: 'android',
        display_name: 'Pixel',
        app_version: '1.0.0',
        app_build: '42',
        os_version: '16',
        capabilities: ['answer'],
      }),
    ).toBe(true)
  })

  it('keeps APNs and FCM registration shapes provider-specific', () => {
    const apns = {
      provider: 'apns',
      environment: 'production',
      token: 'ab'.repeat(32),
    }
    const fcm = { provider: 'fcm', fid: 'opaque-firebase-installation-id' }

    expect(Value.Check(PutRegistrationRequest, apns)).toBe(true)
    expect(Value.Check(PutRegistrationRequest, fcm)).toBe(true)
    expect(Value.Check(PutRegistrationRequest, { provider: 'apns', token: apns.token })).toBe(false)
    expect(
      Value.Check(PutRegistrationRequest, {
        ...fcm,
        environment: 'production',
      }),
    ).toBe(false)
    expect(Value.Check(PutRegistrationRequest, { ...fcm, token: apns.token })).toBe(false)
    expect(Value.Check(PutRegistrationRequest, { provider: 'fcm' })).toBe(false)
  })
})

describe('submission wire contract', () => {
  it('accepts a bounded client request id and exposes the committed reply contract', () => {
    const request = {
      request_id: `req_${'a'.repeat(24)}`,
      idempotency_key: 'submission-wire-1',
      draft: draft(),
    }
    expect(Value.Check(SubmitNotificationRequest, request)).toBe(true)
    expect(
      Value.Check(SubmitNotificationRequest, { ...request, request_id: `req_${'a'.repeat(22)}` }),
    ).toBe(true)
    expect(
      Value.Check(SubmitNotificationRequest, { ...request, request_id: `req_${'a'.repeat(21)}` }),
    ).toBe(false)
    expect(
      Value.Check(SubmitNotificationRequest, { ...request, request_id: `req_${'a'.repeat(25)}` }),
    ).toBe(false)

    const receipt: SubmissionReceipt = {
      request_id: request.request_id,
      reply_expires_at: '2026-08-11T12:00:00.000Z',
      agent_acknowledgement_required: true,
      agent_acknowledgement_text_required: false,
      replayed: false,
      overall: 'pending',
      deliveries: [],
      warnings: [],
    }
    expect(receipt.reply_expires_at).toBe('2026-08-11T12:00:00.000Z')
    // The two are independent: a reply request is always acknowledged, and the
    // account decides only whether that acknowledgement carries text.
    expect(receipt.agent_acknowledgement_required).toBe(true)
    expect(receipt.agent_acknowledgement_text_required).toBe(false)
  })
})

describe('Agent Acknowledgement wire contract', () => {
  it('requires bounded non-empty text after service trimming', () => {
    expect(Value.Check(PutAgentAcknowledgementRequest, { text: 'I will deploy staging.' })).toBe(
      true,
    )
    // Text is optional on the wire so a text-free receipt is still recordable;
    // the account's snapshot, not the schema, decides whether text was owed.
    expect(Value.Check(PutAgentAcknowledgementRequest, {})).toBe(true)
    expect(Value.Check(PutAgentAcknowledgementRequest, { text: '' })).toBe(false)
    expect(
      Value.Check(PutAgentAcknowledgementRequest, {
        text: 'x'.repeat(AGENT_ACKNOWLEDGEMENT_MAX_LENGTH + 1),
      }),
    ).toBe(false)
    expect(Value.Check(PutAgentAcknowledgementRequest, { text: '   ' })).toBe(false)
    expect(Value.Check(PutAgentAcknowledgementRequest, { text: '  next step  ' })).toBe(true)
  })

  it('defines pending and recorded reply views plus recorded/replayed PUT results', () => {
    const pending: ListRepliesResponse = {
      request_id: 'req_example',
      reply_expires_at: '2026-08-13T12:00:00.000Z',
      agent_acknowledgement_required: true,
      agent_acknowledgement_text_required: true,
      agent_acknowledgement: null,
      replies: [],
    }
    expect(pending.agent_acknowledgement).toBeNull()

    // Text off is still an acknowledgement: the recorded view carries empty
    // text, which is what a Companion App renders as read-state.
    const textless: PutAgentAcknowledgementResponse = {
      status: 'recorded',
      agent_acknowledgement: { text: '', created_at: '2026-08-13T12:01:00.000Z' },
    }
    expect(textless.agent_acknowledgement.text).toBe('')

    const response: PutAgentAcknowledgementResponse = {
      status: 'recorded',
      agent_acknowledgement: {
        text: 'I will deploy staging.',
        created_at: '2026-08-13T12:01:00.000Z',
      },
    }
    const replayed: PutAgentAcknowledgementResponse = { ...response, status: 'replayed' }
    expect([response.status, replayed.status]).toEqual(['recorded', 'replayed'])
  })
})

describe('feedback wire contract', () => {
  const client = {
    cli_version: '0.5.1',
    cli_channel: 'stable' as const,
    os: 'darwin',
    node: 'v24.0.0',
  }
  const log = {
    encoding: 'gzip+base64' as const,
    bytes: 'H4sIAAAAAAAAA4s=',
    uncompressed_bytes: 0,
    compressed_bytes: 20,
    record_count: 0,
    truncated: false,
    since: '2026-08-13T00:00:00.000Z',
    until: '2026-08-13T01:00:00.000Z',
    schema_version: 1,
  }

  it('accepts a text-only report and a report with a well-shaped log', () => {
    expect(
      Value.Check(SubmitFeedbackRequest, {
        message: 'The send path failed after pairing.',
        include_logs: false,
        client,
      }),
    ).toBe(true)
    expect(
      Value.Check(SubmitFeedbackRequest, {
        message: 'The send path failed after pairing.',
        include_logs: true,
        log,
        client,
      }),
    ).toBe(true)
  })

  it('rejects an empty message, an overlong message, and an unknown log encoding', () => {
    expect(
      Value.Check(SubmitFeedbackRequest, { message: '', include_logs: false, client }),
    ).toBe(false)
    expect(
      Value.Check(SubmitFeedbackRequest, {
        message: 'x'.repeat(4001),
        include_logs: false,
        client,
      }),
    ).toBe(false)
    expect(
      Value.Check(SubmitFeedbackRequest, {
        message: 'ok',
        include_logs: true,
        log: { ...log, encoding: 'plain' },
        client,
      }),
    ).toBe(false)
  })
})

describe('validateDraft', () => {
  it('accepts a minimal valid draft', () => {
    const report = validateDraft(draft())
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
  })

  it('limits collapse keys by UTF-8 bytes rather than JavaScript characters', () => {
    expect(
      validateDraft(
        draft({ delivery: { ttl_seconds: 60, collapse_key: '😀'.repeat(16) } }),
      ).ok,
    ).toBe(true)
    const oversized = validateDraft(
      draft({ delivery: { ttl_seconds: 60, collapse_key: '😀'.repeat(17) } }),
    )
    expect(oversized).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          path: 'delivery.collapse_key',
          message: expect.stringContaining('64 UTF-8 bytes'),
        }),
      ],
    })
  })

  it('carries Notification Request created_at so companions can order by send time', () => {
    const createdAt = new Date('2026-08-25T12:00:00.000Z')
    const ids = { requestId: 'req_x', deliveryId: 'del_x', createdAt }
    const alert = buildApnsEnvelope(draft(), ids, null)
    expect((alert.payload['notifai'] as Record<string, unknown>)['created_at']).toBe(
      createdAt.toISOString(),
    )
    const fcm = JSON.parse(
      buildFcmDataEnvelope(draft(), ids, null).data.notifai,
    ) as Record<string, unknown>
    expect(fcm['created_at']).toBe(createdAt.toISOString())
    const omitted = buildApnsEnvelope(draft(), { requestId: 'req_x', deliveryId: 'del_x' }, null)
    expect((omitted.payload['notifai'] as Record<string, unknown>)['created_at']).toBeUndefined()
  })

  it('carries the delivery receipt token on both alert and silent pushes', () => {
    // The extension authorizes its receipt with this and nothing else, so a
    // payload without it is an extension that cannot report.
    const ids = { requestId: 'req_x', deliveryId: 'del_x', receiptToken: 'r'.repeat(22) }
    const alert = buildApnsEnvelope(draft(), ids, null)
    expect((alert.payload['notifai'] as Record<string, unknown>)['receipt_token']).toBe(
      'r'.repeat(22),
    )
    // A `done` retirement is a background push assembled by a separate branch;
    // it publishes the same identifiers as the alert it retires.
    const retirement = draft({ lifecycle: { tier: 'done', retires_request_id: 'req_old' } })
    const silent = buildApnsEnvelope(retirement, ids, null)
    expect((silent.payload['notifai'] as Record<string, unknown>)['receipt_token']).toBe(
      'r'.repeat(22),
    )
    // Omitted rather than null when absent — no key earns envelope bytes for
    // saying nothing.
    const without = buildApnsEnvelope(draft(), { requestId: 'req_x', deliveryId: 'del_x' }, null)
    expect((without.payload['notifai'] as Record<string, unknown>)['receipt_token']).toBeUndefined()
  })

  it('accepts a draft with a project identifier and renders it in the envelope', () => {
    const withProject = draft({ project: 'my-app.v2' })
    expect(validateDraft(withProject).ok).toBe(true)
    const envelope = buildApnsEnvelope(withProject, { requestId: 'req_x', deliveryId: 'del_x' }, null)
    expect((envelope.payload['notifai'] as Record<string, unknown>)['project']).toBe('my-app.v2')
    // Project sends must run the NSE so the communication upgrade can apply.
    expect((envelope.payload['aps'] as Record<string, unknown>)['mutable-content']).toBe(1)
    expect((envelope.payload['notifai'] as Record<string, unknown>)['project_image_url']).toBeUndefined()

    const withAvatar = buildApnsEnvelope(
      withProject,
      { requestId: 'req_x', deliveryId: 'del_x' },
      null,
      'ios',
      {
        name: 'My App',
        imageUrl: 'https://signed.example/avatar.png',
        avatarRevision: 'med_custom_avatar',
      },
    )
    const notifai = withAvatar.payload['notifai'] as Record<string, unknown>
    expect(notifai['project_image_url']).toBe('https://signed.example/avatar.png')
    expect(notifai['project_avatar_revision']).toBe('med_custom_avatar')
    expect(notifai['project_name']).toBe('My App')
  })

  it('carries structured source context without using the opaque id as display text', () => {
    const withSource = draft({
      project: 'my-app',
      source: {
        session_id: 'sess_abc123',
        session_label: 'Semantic session names',
        session_label_source: 'semantic',
        harness: 'claude-code',
        branch: 'feature/context',
        worktree: 'context-worktree',
      },
    })
    expect(validateDraft(withSource).ok).toBe(true)
    const envelope = buildApnsEnvelope(withSource, { requestId: 'req_x', deliveryId: 'del_x' }, null)
    const notifai = envelope.payload['notifai'] as Record<string, unknown>
    expect(notifai).toMatchObject({
      session_id: 'sess_abc123',
      session_label: 'Semantic session names',
      harness: 'claude-code',
      branch: 'feature/context',
      worktree: 'context-worktree',
    })
    expect(notifai).not.toHaveProperty('session')
  })

  it('enforces session label bounds in the UTF-16 units used by validation', () => {
    expect(
      validateDraft(
        draft({ source: { session_id: 'sess_emoji', session_label: '😀'.repeat(32) } }),
      ).ok,
    ).toBe(true)
    expect(
      validateDraft(
        draft({ source: { session_id: 'sess_emoji', session_label: '😀'.repeat(33) } }),
      ),
    ).toMatchObject({ ok: false })
  })

  it('rejects a display label with no session identity behind it', () => {
    expect(validateDraft(draft({ source: { session_label: 'Invented Label' } }))).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: 'source.session_label' })],
    })
  })

  it('accepts only known provenance attached to an Agent Session label', () => {
    expect(
      validateDraft(
        draft({
          source: {
            session_id: 'sess_exact',
            session_label: 'Generated fallback',
            session_label_source: 'fallback',
          },
        }),
      ).ok,
    ).toBe(true)
    expect(
      validateDraft(
        draft({ source: { session_id: 'sess_exact', session_label_source: 'semantic' } }),
      ),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: 'source.session_label_source' })],
    })
    expect(
      validateDraft(
        draft({
          source: {
            session_id: 'sess_exact',
            session_label: 'Semantic title',
            session_label_source: 'semantic',
            session_label_previous_source: 'fallback',
          },
        }),
      ).ok,
    ).toBe(true)
    expect(
      validateDraft(
        draft({
          source: {
            session_id: 'sess_exact',
            session_label: 'Generated fallback',
            session_label_source: 'fallback',
            session_label_previous_source: 'fallback',
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: 'source.session_label_previous_source' })],
    })
  })

  it('rejects project identifiers outside the slug alphabet', () => {
    const report = validateDraft(draft({ project: 'My App!' }))
    expect(report.ok).toBe(false)
    expect(report.errors[0]?.code).toBe('invalid_request')
  })

  it('rejects schema violations with invalid_request', () => {
    const report = validateDraft({ ...draft(), presentation: { title: '', body: 'x' } })
    expect(report.ok).toBe(false)
    expect(report.errors[0]?.code).toBe('invalid_request')
  })

  it('rejects unknown top-level fields instead of silently dropping them', () => {
    const report = validateDraft({ ...draft(), icon: 'rocket.png' })
    expect(report.ok).toBe(false)
    expect(report.errors[0]?.code).toBe('invalid_request')
  })

  it('accepts the canonical Markdown body bound and rejects one character more', () => {
    expect(
      validateDraft(
        draft({ presentation: { title: 'Bound', body: 'x'.repeat(BODY_MAX_LENGTH) } }),
      ).ok,
    ).toBe(true)
    expect(
      validateDraft(
        draft({ presentation: { title: 'Bound', body: 'x'.repeat(BODY_MAX_LENGTH + 1) } }),
      ).ok,
    ).toBe(false)
  })

  it('accepts up to eight ordered media items with bounded alt text', () => {
    const media = Array.from({ length: 8 }, (_, index) => ({
      media_id: `med_${index}`,
      alt: `Image ${index + 1}`,
    }))
    expect(validateDraft(draft({ presentation: { title: 'Gallery', body: 'Body', media } })).ok).toBe(
      true,
    )
    expect(
      validateDraft(
        draft({
          presentation: {
            title: 'Gallery',
            body: 'Body',
            media: [...media, { media_id: 'med_ninth' }],
          },
        }),
      ).ok,
    ).toBe(false)
    expect(
      validateDraft(
        draft({
          presentation: {
            title: 'Gallery',
            body: 'Body',
            media: [{ media_id: 'med_one', alt: 'x'.repeat(257) }],
          },
        }),
      ).ok,
    ).toBe(false)
  })

  it('warns when an inline canonical media reference is not attached', () => {
    const report = validateDraft(
      draft({
        presentation: {
          title: 'Comparison',
          body: '![diff](media:med_missing)',
          media: [{ media_id: 'med_attached' }],
        },
      }),
    )
    expect(report).toMatchObject({
      ok: true,
      warnings: [
        expect.objectContaining({
          path: 'presentation.body',
          message: expect.stringContaining('media:med_missing'),
        }),
      ],
    })
  })

  it('rejects the deleted detail, singular image, and top-level session shapes', () => {
    const base = draft()
    expect(
      validateDraft({ ...base, presentation: { ...base.presentation, detail: 'legacy' } }).ok,
    ).toBe(false)
    expect(
      validateDraft({
        ...base,
        presentation: { ...base.presentation, image: { media_id: 'med_legacy' } },
      }).ok,
    ).toBe(false)
    expect(validateDraft({ ...base, session: 'legacy-session' }).ok).toBe(false)
  })

  it('reports oversized payloads with payload_too_large', () => {
    const report = validateDraft(
      draft({
        presentation: { title: 'T'.repeat(500), body: 'B'.repeat(2000), subtitle: 'S'.repeat(500) },
        platform: { ios: { custom_data: Object.fromEntries(
          Array.from({ length: 16 }, (_, i) => [`key_${i}`, 'v'.repeat(512)]),
        ) } },
      }),
    )
    expect(report.ok).toBe(false)
    expect(report.errors.some((e) => e.code === 'payload_too_large')).toBe(true)
  })

  it('estimates payload bytes above zero and below the limit for ordinary drafts', () => {
    const bytes = estimateApnsPayloadBytes(draft())
    expect(bytes).toBeGreaterThan(100)
    expect(bytes).toBeLessThan(4096)
  })

  it('adds the fixed APNs reply category and accounts for it in the payload estimate', () => {
    const withoutReply = draft()
    const withReply = draft({ reply: freeTextReply() })
    const envelope = buildApnsEnvelope(withReply, { requestId: 'req_x', deliveryId: 'del_x' }, null)

    expect((envelope.payload['aps'] as Record<string, unknown>)['category']).toBe(REPLY_CATEGORY_ID)
    expect(estimateApnsPayloadBytes(withReply)).toBeGreaterThan(estimateApnsPayloadBytes(withoutReply))
  })

  it('carries the reply window deadline so companions can offer an in-app reply', () => {
    const withReply = draft({ reply: freeTextReply() })
    const deadline = new Date('2026-08-03T09:15:00.000Z')
    const ids = { requestId: 'req_x', deliveryId: 'del_x' }

    const envelope = buildApnsEnvelope(withReply, ids, null, 'ios', null, deadline)
    expect((envelope.payload['notifai'] as Record<string, unknown>)['reply_expires_at']).toBe(
      '2026-08-03T09:15:00.000Z',
    )

    // No reply requested means no deadline to publish, whatever is passed in.
    const withoutReply = buildApnsEnvelope(draft(), ids, null, 'ios', null, deadline)
    expect(
      (withoutReply.payload['notifai'] as Record<string, unknown>)['reply_expires_at'],
    ).toBeUndefined()
  })

  it('validates replies on both companion platforms', () => {
    const withReply = draft({ reply: freeTextReply() })

    expect(validateDraft(withReply, IOS_CAPABILITIES_V1).ok).toBe(true)
    // The Mac registers the reply category and answers through the same
    // outbox, so a reply targeted at it is no longer rejected.
    expect(validateDraft(withReply, MACOS_CAPABILITIES_V1).ok).toBe(true)
  })

  it('carries the acknowledgement snapshot on original questions only', () => {
    const ids = { requestId: 'req_x', deliveryId: 'del_x' }
    const question = draft({ reply: freeTextReply() })
    const required = buildApnsEnvelope(question, ids, null, 'ios', null, new Date(0), null, {
      agentAcknowledgementRequired: true,
    })
    const disabled = buildApnsEnvelope(question, ids, null, 'ios', null, new Date(0), null, {
      agentAcknowledgementRequired: false,
    })
    const ordinary = buildApnsEnvelope(draft(), ids, null, 'ios', null, null, null, {
      agentAcknowledgementRequired: true,
    })

    expect(
      (required.payload['notifai'] as Record<string, unknown>)[
        'agent_acknowledgement_required'
      ],
    ).toBe(true)
    expect(
      (disabled.payload['notifai'] as Record<string, unknown>)[
        'agent_acknowledgement_required'
      ],
    ).toBe(false)
    expect(
      (ordinary.payload['notifai'] as Record<string, unknown>)[
        'agent_acknowledgement_required'
      ],
    ).toBeUndefined()
  })

  it('carries acknowledgement availability metadata without its text', () => {
    const sync = draft({
      lifecycle: { tier: 'done', retires_request_id: 'req_original' },
    })
    const envelope = buildApnsEnvelope(
      sync,
      { requestId: 'req_sync', deliveryId: 'del_sync' },
      null,
      'ios',
      null,
      null,
      null,
      null,
      { createdAt: new Date('2026-08-13T12:01:00.000Z') },
    )
    const notifai = envelope.payload['notifai'] as Record<string, unknown>
    expect(notifai['agent_acknowledgement_available']).toBe(true)
    expect(notifai['agent_acknowledgement_created_at']).toBe('2026-08-13T12:01:00.000Z')
    expect(JSON.stringify(envelope.payload)).not.toContain('I will deploy')
    expect(notifai).not.toHaveProperty('agent_acknowledgement_text')
  })

  it('carries the question set to the device and picks the answering surface', () => {
    const ids = { requestId: 'req_x', deliveryId: 'del_x' }
    const choices = [
      { id: 'staging', label: 'Staging' },
      { id: 'prod', label: 'Production' },
    ]
    const questions = [{ id: 'target', text: 'Deploy where?', choices }]
    const question = draft({ reply: { expires_in_seconds: 3600, questions } })

    const envelope = buildApnsEnvelope(question, ids, null)
    expect((envelope.payload['notifai'] as Record<string, unknown>)['questions']).toEqual(questions)
    // Choices are answered on the content-extension card.
    expect((envelope.payload['aps'] as Record<string, unknown>)['category']).toBe(
      REPLY_CHOICE_CATEGORY_ID,
    )

    // A single free-text question keeps the system inline-reply keyboard, and
    // still carries its question set for the in-app surfaces.
    const text = buildApnsEnvelope(draft({ reply: freeTextReply() }), ids, null)
    expect((text.payload['notifai'] as Record<string, unknown>)['questions']).toHaveLength(1)
    expect((text.payload['aps'] as Record<string, unknown>)['category']).toBe(REPLY_CATEGORY_ID)

    // Several questions are a form, and forms live on the card — even when
    // every question is free text.
    const form = draft({
      reply: {
        expires_in_seconds: 3600,
        questions: [
          { id: 'one', text: 'First?' },
          { id: 'two', text: 'Second?' },
        ],
      },
    })
    const formEnvelope = buildApnsEnvelope(form, ids, null)
    expect((formEnvelope.payload['aps'] as Record<string, unknown>)['category']).toBe(
      REPLY_CHOICE_CATEGORY_ID,
    )
  })

  it('puts a press-and-hold affordance on the collapsed closed-choice banner, never the labels', () => {
    const ids = { requestId: 'req_x', deliveryId: 'del_x' }
    const secretLabel = 'Revoke the leaked production key'
    const questions = [
      {
        id: 'key',
        text: 'The API key in .env.example is live. What now?',
        choices: [
          { id: 'revoke', label: secretLabel },
          { id: 'wait', label: 'Wait for the replacement' },
        ],
      },
    ]
    const questionBody = 'The API key in .env.example is live. What now?'
    const question = draft({
      presentation: { title: 'API key is live', body: questionBody },
      reply: { expires_in_seconds: 3600, questions },
    })

    const envelope = buildApnsEnvelope(question, ids, null, 'ios')
    const alert = (envelope.payload['aps'] as Record<string, unknown>)['alert'] as Record<
      string,
      unknown
    >
    expect(alert).toEqual({
      title: 'API key is live',
      subtitle: CLOSED_CHOICE_BANNER_AFFORDANCE,
      body: questionBody,
    })
    expect(JSON.stringify(alert)).not.toContain(secretLabel)
    expect(JSON.stringify(alert)).not.toContain('Wait for the replacement')
    expect((envelope.payload['notifai'] as Record<string, unknown>)['questions']).toEqual(questions)

    const macos = buildApnsEnvelope(question, ids, null, 'macos')
    const macosAlert = (macos.payload['aps'] as Record<string, unknown>)['alert'] as Record<
      string,
      unknown
    >
    expect(macosAlert.subtitle).toBeUndefined()
    expect(JSON.stringify(macosAlert)).not.toContain(CLOSED_CHOICE_BANNER_AFFORDANCE)

    const fcm = JSON.parse(buildFcmDataEnvelope(question, ids, null).data.notifai) as Record<
      string,
      unknown
    >
    expect(JSON.stringify(fcm)).not.toContain(CLOSED_CHOICE_BANNER_AFFORDANCE)

    const withSubtitle = draft({
      presentation: {
        title: 'API key is live',
        subtitle: 'It is in the example file',
        body: questionBody,
      },
      reply: { expires_in_seconds: 3600, questions },
    })
    const subtitled = collapsedChoiceAlert(withSubtitle, 'ios')
    expect(subtitled.subtitle).toBe('It is in the example file')
    expect(subtitled.body).toBe(`${questionBody}\n${CLOSED_CHOICE_BANNER_AFFORDANCE}`)
    expect(JSON.stringify(subtitled)).not.toContain(secretLabel)

    const freeText = buildApnsEnvelope(draft({ reply: freeTextReply() }), ids, null)
    const freeTextAlert = (freeText.payload['aps'] as Record<string, unknown>)['alert'] as Record<
      string,
      unknown
    >
    expect(JSON.stringify(freeTextAlert)).not.toContain(CLOSED_CHOICE_BANNER_AFFORDANCE)
  })

  it('rejects question sets that cannot be answered unambiguously', () => {
    // A reply block with nothing asked is not a question.
    expect(validateDraft(draft({ reply: { expires_in_seconds: 3600 } as never })).ok).toBe(false)

    // Two answers the agent cannot tell apart.
    expect(
      validateDraft(
        draft({
          reply: {
            expires_in_seconds: 3600,
            questions: [
              {
                id: 'q',
                text: 'Yes?',
                choices: [
                  { id: 'yes', label: 'Yes' },
                  { id: 'yes', label: 'Yeah' },
                ],
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: 'reply.questions.0.choices' })],
    })

    // Two questions the agent cannot tell apart.
    expect(
      validateDraft(
        draft({
          reply: {
            expires_in_seconds: 3600,
            questions: [
              { id: 'q', text: 'First?' },
              { id: 'q', text: 'Second?' },
            ],
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: 'reply.questions.1' })],
    })

    // Multi-select needs choices to select between.
    expect(
      validateDraft(
        draft({
          reply: { expires_in_seconds: 3600, questions: [{ id: 'q', text: 'Say more?', multi: true }] },
        }),
      ),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ path: 'reply.questions.0.multi' })],
    })
  })

  it('rejects the pre-questions reply shape outright', () => {
    // The product is not live and carries no compatibility shims: the old
    // kind/choices reply block is an invalid draft, not a tolerated one.
    const legacy = draft({
      reply: {
        expires_in_seconds: 86400,
        kind: 'choice',
        choices: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      } as never,
    })
    expect(validateDraft(legacy, IOS_CAPABILITIES_V1).ok).toBe(false)
  })

  it('describes the iOS, macOS, and Android capability contracts', () => {
    expect(CAPABILITIES_V1.describe('ios')?.platform).toBe('ios')
    expect(CAPABILITIES_V1.describe('macos')).toBe(MACOS_CAPABILITIES_V1)
    expect(CAPABILITIES_V1.describe('android')).toBe(ANDROID_CAPABILITIES_V1)
    expect([
      IOS_CAPABILITIES_V1,
      MACOS_CAPABILITIES_V1,
      ANDROID_CAPABILITIES_V1,
    ].map((document) => document.notification_contract_fingerprint)).toEqual([
      NOTIFICATION_CONTRACT_FINGERPRINT,
      NOTIFICATION_CONTRACT_FINGERPRINT,
      NOTIFICATION_CONTRACT_FINGERPRINT,
    ])
    expect(MACOS_CAPABILITIES_V1.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'presentation.media', status: 'downgraded' }),
        expect.objectContaining({ path: 'presentation.body', status: 'supported' }),
        expect.objectContaining({ path: 'source', status: 'supported' }),
        expect.objectContaining({ path: 'reply', status: 'supported' }),
        expect.objectContaining({ path: 'platform.macos.sound', status: 'supported' }),
        expect.objectContaining({ path: 'platform.macos.thread_id', status: 'supported' }),
        expect.objectContaining({ path: 'platform.macos.category', status: 'unsupported' }),
      ]),
    )
    expect(MACOS_CAPABILITIES_V1.fields.some((field) => field.path === 'sound_file')).toBe(false)
    expect(ANDROID_CAPABILITIES_V1).toMatchObject({
      platform: 'android',
      payload_limit_bytes: 4096,
      interruption_levels: [],
    })
    expect(ANDROID_CAPABILITIES_V1.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'presentation.media', status: 'downgraded' }),
        expect.objectContaining({ path: 'presentation.body', status: 'supported' }),
        expect.objectContaining({ path: 'reply', status: 'supported' }),
        expect.objectContaining({ path: 'platform.android.sound', status: 'supported' }),
        expect.objectContaining({ path: 'platform.android.thread_id', status: 'downgraded' }),
        expect.objectContaining({ path: 'platform.android.badge', status: 'unsupported' }),
        expect.objectContaining({
          path: 'platform.android.interruption_level',
          status: 'unsupported',
        }),
        expect.objectContaining({ path: 'localization', status: 'unsupported' }),
      ]),
    )
  })

  it('warns when the macOS banner omits an ordered media collection', () => {
    const withMedia = draft({
      presentation: {
        title: 'Hi',
        body: 'Body',
        media: [{ media_id: 'med_first' }, { media_id: 'med_second', alt: 'Graph' }],
      },
    })

    expect(validateDraft(withMedia, MACOS_CAPABILITIES_V1)).toMatchObject({
      ok: true,
      errors: [],
      warnings: [
        {
          path: 'presentation.media',
          message: expect.stringContaining('banner omits images'),
        },
      ],
    })
    expect(validateDraft(withMedia, IOS_CAPABILITIES_V1).warnings).toEqual([])
  })

  it('reports Android native-surface downgrades without rejecting supported in-app behavior', () => {
    const androidDraft = draft({
      presentation: {
        title: 'Choose',
        body: 'Choose a deployment target.',
        media: [{ media_id: 'med_graph' }],
      },
      reply: {
        expires_in_seconds: 3600,
        questions: [
          {
            id: 'target',
            text: 'Deploy where?',
            choices: [
              { id: 'staging', label: 'Staging' },
              { id: 'production', label: 'Production' },
            ],
          },
        ],
      },
      platform: { android: { thread_id: 'deployments' } },
    })

    expect(validateDraft(androidDraft, ANDROID_CAPABILITIES_V1)).toMatchObject({
      ok: true,
      errors: [],
      warnings: expect.arrayContaining([
        expect.objectContaining({
          path: 'reply',
          message: expect.stringContaining('Companion App'),
        }),
        expect.objectContaining({
          path: 'presentation.media',
          message: expect.stringContaining('text notification first'),
        }),
        expect.objectContaining({
          path: 'platform.android.thread_id',
          message: expect.stringContaining('device manufacturer'),
        }),
      ]),
    })
    expect(validateDraft(draft({ reply: freeTextReply() }), ANDROID_CAPABILITIES_V1).warnings).toEqual(
      [],
    )
  })

  it('warns when a target requests Time Sensitive behavior without the capability', () => {
    const timeSensitive = draft({
      platform: { ios: { interruption_level: 'time_sensitive' } },
    })
    const macTimeSensitive = draft({
      platform: { macos: { interruption_level: 'time_sensitive' } },
    })
    const active = draft({ platform: { ios: { interruption_level: 'active' } } })

    expect(validateDraft(timeSensitive, IOS_CAPABILITIES_V1)).toMatchObject({
      ok: true,
      warnings: [
        {
          path: 'platform.ios.interruption_level',
          message: expect.stringContaining('Time Sensitive breakthrough is unavailable'),
        },
      ],
    })
    expect(validateDraft(macTimeSensitive, MACOS_CAPABILITIES_V1).warnings).toEqual([
      expect.objectContaining({ path: 'platform.macos.interruption_level' }),
    ])
    expect(validateDraft(active, IOS_CAPABILITIES_V1).warnings).toEqual([])
  })

  it('uses the same APNs envelope rules for estimation and rendering', () => {
    const withMedia = draft({
      source: {
        session_id: 'sess_example',
        session_label: 'Amber Falcon',
        harness: 'codex',
        branch: 'feature/media',
        worktree: 'media-worktree',
      },
      presentation: {
        title: 'All checks passed',
        body: '**All checks passed.**\n\nSee the attached graph.',
        media: [{ media_id: 'med_example', alt: 'Build graph' }],
      },
      platform: { ios: {} },
    })
    const mediaUrl = 'https://x.invalid/'.padEnd(500, 'a')
    const envelope = buildApnsEnvelope(
      withMedia,
      {
        requestId: 'req_00000000000000000000000000',
        deliveryId: 'del_00000000000000000000000000',
        receiptToken: '0'.repeat(RECEIPT_TOKEN_LENGTH),
        createdAt: new Date(0),
      },
      mediaUrl,
    )
    const aps = envelope.payload['aps'] as Record<string, unknown>
    const alert = aps['alert'] as Record<string, unknown>
    const notifai = envelope.payload['notifai'] as Record<string, unknown>

    expect(alert['body']).toBe('All checks passed.\nSee the attached graph.')
    expect(aps['interruption-level']).toBe('active')
    expect(aps['mutable-content']).toBe(1)
    expect(notifai).toMatchObject({ has_full_body: true, media_count: 1 })
    expect(estimateApnsPayloadBytes(withMedia)).toBe(
      new TextEncoder().encode(JSON.stringify(envelope.payload)).length,
    )
  })

  it('serializes the application-owned Android envelope once inside FCM data', () => {
    const androidDraft = draft({
      kind: 'done',
      project: 'my-app',
      source: {
        session_id: 'sess_example',
        session_label: 'Amber Falcon',
        harness: 'codex',
        branch: 'feature/android',
        worktree: 'android-worktree',
      },
      presentation: {
        title: 'All checks passed',
        subtitle: 'Android lane',
        body: '**All checks passed.**\n\nSee the attached graph.',
        media: [{ media_id: 'med_example', alt: 'Build graph' }],
      },
      delivery: { ttl_seconds: 3600, collapse_key: 'android-builds' },
      reply: freeTextReply(),
      platform: {
        android: {
          sound: 'done',
          thread_id: 'builds',
          custom_data: { run_id: '42' },
        },
      },
    })
    const envelope = buildFcmDataEnvelope(
      androidDraft,
      {
        requestId: 'req_00000000000000000000000000',
        deliveryId: 'del_00000000000000000000000000',
        receiptToken: '0'.repeat(RECEIPT_TOKEN_LENGTH),
        createdAt: new Date(0),
      },
      'https://x.invalid/'.padEnd(500, 'a'),
      {
        name: 'n'.padEnd(128, 'n'),
        imageUrl: 'https://x.invalid/'.padEnd(500, 'a'),
        avatarRevision: 'a'.repeat(128),
      },
      new Date(0),
      null,
      { agentAcknowledgementRequired: true },
      null,
    )
    const applicationEnvelope = JSON.parse(envelope.data.notifai) as Record<string, unknown>

    expect(envelope.priority).toBe('HIGH')
    expect(envelope.data).toEqual({ notifai: JSON.stringify(applicationEnvelope) })
    expect(applicationEnvelope).toMatchObject({
      schema_version: 1,
      request_id: 'req_00000000000000000000000000',
      delivery_id: 'del_00000000000000000000000000',
      kind: 'question',
      title: 'All checks passed',
      banner_excerpt: 'All checks passed.\nSee the attached graph.',
      collapse_key: 'android-builds',
      sound: 'done',
      thread_id: 'builds',
      custom_data: { run_id: '42' },
      media_count: 1,
      has_full_body: true,
      project_avatar_revision: 'a'.repeat(128),
    })
    expect(estimateFcmPayloadBytes(androidDraft)).toBe(
      new TextEncoder().encode(JSON.stringify(envelope.data)).length,
    )
  })

  it('rejects an Android data map above the FCM payload ceiling', () => {
    const oversized = draft({
      presentation: {
        title: 'T'.repeat(512),
        subtitle: 'S'.repeat(512),
        body: 'B'.repeat(2048),
      },
      platform: {
        android: {
          custom_data: Object.fromEntries(
            Array.from({ length: 16 }, (_, index) => [`key_${index}`, 'v'.repeat(512)]),
          ),
        },
      },
    })

    expect(validateDraft(oversized, ANDROID_CAPABILITIES_V1)).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'payload_too_large',
          message: expect.stringContaining('FCM payload'),
        }),
      ],
    })
  })

  it('keeps maximum acknowledgement metadata estimation equal to rendering', () => {
    const maximum = draft({
      presentation: {
        title: 'T'.repeat(512),
        subtitle: 'S'.repeat(512),
        body: 'B'.repeat(2048),
      },
      lifecycle: { tier: 'done', retires_request_id: 'req_original' },
      delivery: { ttl_seconds: 60, collapse_key: 'c'.repeat(64) },
    })
    const envelope = buildApnsEnvelope(
      maximum,
      {
        requestId: 'req_00000000000000000000000000',
        deliveryId: 'del_00000000000000000000000000',
        receiptToken: '0'.repeat(RECEIPT_TOKEN_LENGTH),
        createdAt: new Date(0),
      },
      null,
      'ios',
      null,
      null,
      null,
      null,
      { createdAt: new Date(0) },
    )
    const rendered = new TextEncoder().encode(JSON.stringify(envelope.payload)).length
    expect(estimateApnsPayloadBytes(maximum)).toBe(rendered)
    expect(rendered).toBeLessThanOrEqual(IOS_CAPABILITIES_V1.payload_limit_bytes)
  })

  it('uses macOS platform options in the shared APNs envelope', () => {
    const macosDraft = draft({
      presentation: { title: 'Hi', body: 'Body' },
      platform: {
        macos: {
          sound: null,
          badge: 3,
          thread_id: 'desktop-builds',
          interruption_level: 'passive',
          relevance_score: 0.8,
          target_content_id: 'build-detail',
          custom_data: { run_id: '42' },
        },
      },
    })
    const envelope = buildApnsEnvelope(
      macosDraft,
      {
        requestId: 'req_00000000000000000000000000',
        deliveryId: 'del_00000000000000000000000000',
        receiptToken: '0'.repeat(RECEIPT_TOKEN_LENGTH),
        createdAt: new Date(0),
      },
      null,
      'macos',
    )
    const aps = envelope.payload['aps'] as Record<string, unknown>
    const notifai = envelope.payload['notifai'] as Record<string, unknown>

    expect(envelope.priority).toBe(5)
    expect(aps).toMatchObject({
      badge: 3,
      'thread-id': 'desktop-builds',
      'interruption-level': 'passive',
      'relevance-score': 0.8,
      'target-content-id': 'build-detail',
    })
    expect(aps).not.toHaveProperty('sound')
    expect(notifai['data']).toEqual({ run_id: '42' })
    expect(estimateApnsPayloadBytes(macosDraft, 'macos')).toBe(
      new TextEncoder().encode(JSON.stringify(envelope.payload)).length,
    )
  })
})

describe('question lifecycle (D-A, D-B, D-C)', () => {
  it('renders a done draft as a silent background state sync', () => {
    const retirement = draft({
      lifecycle: { tier: 'done', state: 'answered', retires_request_id: 'req_original' },
      delivery: { ttl_seconds: 60, collapse_key: 'notifai-hook-q1' },
      // Presentation options that would be visible must not survive into the
      // silent form: Apple forbids alert, sound, and badge alongside
      // content-available.
      platform: { ios: { sound: 'done', badge: 2, interruption_level: 'time_sensitive' } },
    })
    const envelope = buildApnsEnvelope(retirement, { requestId: 'req_x', deliveryId: 'del_x' }, null)

    expect(envelope.payload['aps']).toEqual({
      'content-available': 1,
      'mutable-content': 1,
    })
    expect(envelope.pushType).toBe('background')
    // 5 is the only legal priority for a background push.
    expect(envelope.priority).toBe(5)
    const notifai = envelope.payload['notifai'] as Record<string, unknown>
    // The lifecycle and the two correlation ids are the whole message: the
    // collapse key removes the DELIVERED notification, retires_request_id
    // finds the on-device HISTORY entry and marks it done.
    expect(notifai['lifecycle']).toEqual({
      tier: 'done',
      state: 'answered',
      retires_request_id: 'req_original',
    })
    expect(notifai['retires_request_id']).toBe('req_original')
    expect(notifai['collapse_key']).toBe('notifai-hook-q1')
  })

  it('publishes retires_request_id only on a done draft', () => {
    const ids = { requestId: 'req_x', deliveryId: 'del_x' }
    // Schema-valid but meaningless: an end detail on a live tier is rejected.
    expect(
      validateDraft(
        draft({ lifecycle: { tier: 'needs_you', retires_request_id: 'req_original' } }),
      ),
    ).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({ code: 'invalid_request', path: 'lifecycle.retires_request_id' }),
      ],
    })
    // An alert never carries the retirement pointer.
    const plain = buildApnsEnvelope(draft(), ids, null)
    expect((plain.payload['notifai'] as Record<string, unknown>)['retires_request_id']).toBeUndefined()
  })

  it('keeps needs-you and lifecycle-less drafts as alerts', () => {
    const ids = { requestId: 'req_x', deliveryId: 'del_x' }
    const question = draft({ lifecycle: { tier: 'needs_you' }, reply: freeTextReply(3600) })
    const envelope = buildApnsEnvelope(question, ids, null)

    expect(envelope.pushType).toBe('alert')
    expect((envelope.payload['aps'] as Record<string, unknown>)['alert']).toBeDefined()
    expect((envelope.payload['notifai'] as Record<string, unknown>)['lifecycle']).toEqual({
      tier: 'needs_you',
    })

    // Absent means new: pre-lifecycle clients change meaning for nothing.
    const plain = buildApnsEnvelope(draft(), ids, null)
    expect(plain.pushType).toBe('alert')
    expect((plain.payload['notifai'] as Record<string, unknown>)['lifecycle']).toBeUndefined()
  })

  it('rejects invalid lifecycle end states', () => {
    expect(
      validateDraft(draft({ lifecycle: { tier: 'needs_you', state: 'answered' } })),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'invalid_request', path: 'lifecycle.state' })],
    })
    expect(
      validateDraft(draft({ lifecycle: { tier: 'done', state: 'superseded' } as never })),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'invalid_request', path: 'lifecycle.state' })],
    })
  })
})

describe('notification kind', () => {
  const notifaiKeyOf = (d: NotificationDraftT) =>
    buildApnsEnvelope(d, { requestId: 'req_k', deliveryId: 'del_k' }, null).payload[
      'notifai'
    ] as Record<string, unknown>

  it('omits the default so it costs nothing in a 4096-byte envelope', () => {
    expect(notifaiKeyOf(draft({}))).not.toHaveProperty('kind')
    expect(notifaiKeyOf(draft({ kind: 'update' }))).not.toHaveProperty('kind')
    expect(effectiveKind(draft({}))).toBe('update')
  })

  it('carries finished work to the device', () => {
    expect(notifaiKeyOf(draft({ kind: 'done' }))['kind']).toBe('done')
    // The pre-flight size check shares the assembly, so a new key can never be
    // charged to the 4096-byte budget at send time but not at estimate time.
    expect(estimateApnsPayloadBytes(draft({ kind: 'done' }), 'ios')).toBeGreaterThan(
      estimateApnsPayloadBytes(draft({}), 'ios'),
    )
  })

  it('derives question from the reply window rather than trusting the label', () => {
    // A reply block is a question by construction, so the sender cannot get
    // this one wrong — and cannot get it wrong in the other direction either.
    const asked = draft({ reply: freeTextReply(3600) })
    expect(effectiveKind(asked)).toBe('question')
    expect(notifaiKeyOf(asked)['kind']).toBe('question')
    expect(effectiveKind(draft({ kind: 'done', reply: freeTextReply(3600) }))).toBe(
      'question',
    )
  })

  it('rejects a question nobody can answer', () => {
    expect(validateDraft(draft({ kind: 'question' }))).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'invalid_request', path: 'kind' })],
    })
    expect(validateDraft(draft({ kind: 'question', reply: freeTextReply(3600) })).ok).toBe(
      true,
    )
  })

  it('carries failed and blocked as closed semantic kinds', () => {
    expect(validateDraft(draft({ kind: 'failed' })).ok).toBe(true)
    expect(validateDraft(draft({ kind: 'blocked' })).ok).toBe(true)
    expect(notifaiKeyOf(draft({ kind: 'failed' }))['kind']).toBe('failed')
    expect(notifaiKeyOf(draft({ kind: 'blocked' }))['kind']).toBe('blocked')
    expect(
      (buildApnsEnvelope(draft({ kind: 'failed' }), { requestId: 'req_k', deliveryId: 'del_k' }, null)
        .payload['aps'] as Record<string, unknown>)['sound'],
    ).toBe('alert.caf')
    expect(
      (buildApnsEnvelope(draft({ kind: 'blocked' }), { requestId: 'req_k', deliveryId: 'del_k' }, null)
        .payload['aps'] as Record<string, unknown>)['sound'],
    ).toBe('attention.caf')
    expect(
      (
        buildApnsEnvelope(
          draft({ platform: { ios: { sound: 'snd_chime' } } }),
          { requestId: 'req_custom_sound', deliveryId: 'del_custom_sound' },
          null,
        ).payload['aps'] as Record<string, unknown>
      )['sound'],
    ).toBe('notifai-snd_chime.wav')
  })

  it('emits a distinct silent sound-library sync without alert, sound, or badge', () => {
    expect(buildSoundLibrarySyncEnvelope()).toEqual({
      payload: {
        aps: { 'content-available': 1 },
        notifai: { sync: 'sound_library' },
      },
      priority: 5,
      pushType: 'background',
    })
  })

  it('rejects a kind outside the closed vocabulary', () => {
    expect(
      validateDraft(draft({ kind: 'progress' } as unknown as Partial<NotificationDraftT>)).ok,
    ).toBe(false)
  })
})

describe('summarizeOverall', () => {
  it('is pending while any delivery is unsettled', () => {
    expect(summarizeOverall(['queued', 'provider_accepted'])).toBe('pending')
    expect(summarizeOverall(['retry_scheduled'])).toBe('pending')
  })
  it('classifies settled sets', () => {
    expect(summarizeOverall(['provider_accepted', 'provider_accepted'])).toBe('provider_accepted_all')
    expect(summarizeOverall(['provider_rejected', 'expired'])).toBe('provider_rejected_all')
    expect(summarizeOverall(['provider_accepted', 'outcome_unknown'])).toBe('provider_accepted_partial')
  })
  it('is pending for the empty set', () => {
    expect(summarizeOverall([])).toBe('pending')
  })
})
