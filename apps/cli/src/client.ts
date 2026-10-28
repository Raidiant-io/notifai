import type {
  ApiErrorBody,
  AttendanceBatchRequestT,
  AttendanceBatchResponse,
  AttendanceRequestT,
  AttendanceResponse,
  AlphaAccessRequestResponse,
  AccountAccessResponse,
  BeginPairingResponse,
  ExtendPairingResponse,
  MachineSetupNotificationResponse,
  CapabilityDocument,
  CreateMediaUploadRequestT,
  CreateMediaUploadResponse,
  FinalizeMediaUploadResponse,
  EvidenceSnapshot,
  GetAgentAcknowledgementResponse,
  ListDevicesResponse,
  ListSoundsResponse,
  ClaimDeliveryAttemptRequestT,
  ClaimDeliveryAttemptResponse,
  ClientCapability,
  CloseDisposition,
  CloseRepliesRequestT,
  CloseRepliesResponse,
  CloseRetirementState,
  CompatibilityResponse,
  GetSessionMessageAcknowledgementResponse,
  RecoveryAction,
  ListRepliesResponse,
  Platform,
  PollPairingResponse,
  PutAgentAcknowledgementRequestT,
  PutAgentAcknowledgementResponse,
  RecordHarnessAnswerRequestT,
  RecordHarnessAnswerResponse,
  PutAgentSessionLabelRequestT,
  PutSessionMessageAcknowledgementRequestT,
  PutSessionMessageAcknowledgementResponse,
  ReportDeliveryAttemptRequestT,
  ReportDeliveryAttemptResponse,
  AgentSessionView,
  SubmissionReceipt,
  SubmitNotificationRequestT,
} from '@raidiant/notifai-protocol'
import {
  CAPABILITIES_HEADER,
  CLI_VERSION_HEADER,
  NOTIFICATION_CONTRACT_HEADER,
} from '@raidiant/notifai-protocol'
import type { Logger } from './logging.js'

export class ApiCallError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public nextAction: string | null = null,
    public details: unknown = null,
    public recoveryAction: RecoveryAction | null = null,
  ) {
    super(message)
  }
}

export class NetworkError extends Error {}

/** The caller cancelled the request itself (a cut long-poll, a credential change); not a fault. */
export class RequestCancelledError extends NetworkError {}

/**
 * Whether a replies-poll failure is temporary while the durable request stays
 * live. Transport faults, throttling, request timeouts, and server failures
 * can recover on a later poll; client errors cannot be repaired by retrying
 * the same authenticated request.
 */
export function isRetryableReplyPollError(err: unknown): boolean {
  if (err instanceof NetworkError) return true
  if (!(err instanceof ApiCallError)) return false
  return err.status >= 500 || err.status === 429 || err.status === 408
}

/**
 * A deadline that fired reads as an abort, which says nothing useful on its
 * own. Naming the timeout is what lets someone tell a hung server apart from a
 * refused connection.
 */
function networkFailure(err: unknown, root: string, limitMs: number): NetworkError {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new NetworkError(`${root} did not respond within ${Math.round(limitMs / 1000)}s`)
  }
  return new NetworkError(`Could not reach ${root}: ${String(err)}`)
}

export interface ApiClient {
  beginPairing(body: {
    machine_name: string
    credential_hash: string
    poll_verifier_hash: string
    confirmation_hash: string
    lifetime_seconds?: number
  }): Promise<BeginPairingResponse>
  pollPairing(pairingId: string, pollVerifier: string): Promise<PollPairingResponse>
  requestPairingNotification(pairingId: string, pollVerifier: string, email: string): Promise<{ status: 'requested' }>
  /** Keep a waiting approval open; same code and confirmation secret, new `expires_at`. */
  extendPairing(pairingId: string, pollVerifier: string, lifetimeSeconds?: number): Promise<ExtendPairingResponse>
  /** Revoke the calling machine's own credential; it stops working on the next request. */
  revokeMachine(): Promise<{ ok: true }>
  /** When this computer's Setup notification last went out (past 24 hours), from here or the browser. */
  setupNotification(): Promise<MachineSetupNotificationResponse>
  accessStatus(): Promise<AccountAccessResponse>
  /**
   * Read-only. There is no client-side write: filing this errand is the
   * User's decision, and the server refuses it from a machine credential.
   */
  accessRequest(): Promise<AlphaAccessRequestResponse>
  listDevices(): Promise<ListDevicesResponse>
  listSounds(): Promise<ListSoundsResponse>
  capabilities(
    platform?: Platform,
    appVersion?: string,
    appBuild?: string,
  ): Promise<CapabilityDocument>
  compatibility(): Promise<CompatibilityResponse>
  submit(body: SubmitNotificationRequestT, waitSeconds: number): Promise<SubmissionReceipt>
  evidence(requestId: string): Promise<EvidenceSnapshot>
  replies(
    requestId: string,
    options: { waitSeconds: number; afterSeq: number },
  ): Promise<ListRepliesResponse>
  /**
   * Close a question's reply window and return the replies committed before
   * the close fence. `disposition` says why: `deliver` only when this caller
   * will claim the fenced answer for hand-off, `retire` on every retirement.
   * Without one the close records none, exactly as released CLIs do.
   * `retirement` says how a retired question ended when the caller knows, so
   * the devices never show a withdrawn question as answered elsewhere.
   */
  closeReplies(requestId: string): Promise<ListRepliesResponse>
  closeReplies(
    requestId: string,
    disposition: CloseDisposition,
    retirement?: CloseRetirementState,
  ): Promise<CloseRepliesResponse>
  closeReplies(
    requestId: string,
    disposition?: CloseDisposition,
    retirement?: CloseRetirementState,
  ): Promise<ListRepliesResponse | CloseRepliesResponse>
  putAgentAcknowledgement(
    requestId: string,
    body: PutAgentAcknowledgementRequestT,
  ): Promise<PutAgentAcknowledgementResponse>
  recordHarnessAnswer(requestId: string, body: RecordHarnessAnswerRequestT): Promise<RecordHarnessAnswerResponse>
  upgradeAgentSessionLabel(body: PutAgentSessionLabelRequestT): Promise<AgentSessionView>
  putAgentSessionLabel(body: PutAgentSessionLabelRequestT): Promise<AgentSessionView>
  agentAcknowledgement(
    requestId: string,
    options: { waitSeconds: number },
  ): Promise<GetAgentAcknowledgementResponse>
  createMediaUpload(body: CreateMediaUploadRequestT): Promise<CreateMediaUploadResponse>
  finalizeMediaUpload(mediaId: string): Promise<FinalizeMediaUploadResponse>
  uploadMedia(grant: CreateMediaUploadResponse, bytes: Uint8Array): Promise<void>
  health(): Promise<boolean>
  /**
   * One Session Attendant exchange for an exact Agent Session. The server may
   * hold a `running` exchange up to `waitSeconds`; `signal` cuts it short.
   */
  attend(
    sessionId: string,
    body: AttendanceRequestT,
    options: { waitSeconds: number; signal?: AbortSignal },
  ): Promise<AttendanceResponse>
  /**
   * One batched exchange for many Agent Sessions (the hub). Offered when the
   * service lists `session_attendance_batch`.
   */
  attendBatch(
    body: AttendanceBatchRequestT,
    options: { waitSeconds: number; signal?: AbortSignal },
  ): Promise<AttendanceBatchResponse>
  /** Claim one hand-off into an Agent Session under the lease generation held. */
  claimDeliveryAttempt(
    sessionId: string,
    body: ClaimDeliveryAttemptRequestT,
  ): Promise<ClaimDeliveryAttemptResponse>
  /** Report how a claimed hand-off ended; accepted from the attempt's machine only. */
  reportDeliveryAttempt(
    attemptId: string,
    body: ReportDeliveryAttemptRequestT,
  ): Promise<ReportDeliveryAttemptResponse>
  putSessionMessageAcknowledgement(
    messageId: string,
    body: PutSessionMessageAcknowledgementRequestT,
  ): Promise<PutSessionMessageAcknowledgementResponse>
  sessionMessageAcknowledgement(messageId: string): Promise<GetSessionMessageAcknowledgementResponse>
}

export interface ClientOptions {
  /**
   * Ceiling for a single request, on top of any long poll the server has been
   * asked to hold. Callers running inside a harness hook shrink this so their
   * whole network path stays inside the budget the harness allows them.
   */
  timeoutMs?: number
  /**
   * Absolute wall-clock ceiling for the caller's whole operation. This is
   * intentionally separate from `timeoutMs`: a late long poll must not get a
   * fresh per-request allowance after its owning harness hook is nearly done.
   */
  deadlineAt?: number
  /** Test seam for `deadlineAt`; production uses the wall clock. */
  now?: () => number
  /**
   * Records each call locally. Worth having because the two failures that cost
   * the most time — a server older than this CLI, and a network path that only
   * fails inside a hook — both look identical from outside and are told apart
   * instantly by a status code and a duration.
   */
  logger?: Pick<Logger, 'debug' | 'error'>
  /** Artifact identity and named jobs advertised only on authenticated traffic. */
  cliVersion?: string | null
  capabilities?: readonly ClientCapability[]
  /** Complete Notification Request schema this authenticated client will submit. */
  notificationContractFingerprint?: string | null
  /**
   * Ends every request of this client, in flight or later, once aborted: the
   * hub aborts it when the credential changes, so nothing it started with the
   * old credential is sent afterwards.
   */
  signal?: AbortSignal
}

/** Generous enough for a slow link, short enough that nothing hangs for ever. */
export const DEFAULT_TIMEOUT_MS = 20_000

export function createClient(
  baseUrl: string,
  bearer: string | null,
  options: ClientOptions = {},
): ApiClient {
  const root = baseUrl.replace(/\/$/, '')
  const budgetMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const logger = options.logger
  const clientHeaders: Record<string, string> = bearer
    ? {
        ...(options.cliVersion ? { [CLI_VERSION_HEADER]: options.cliVersion } : {}),
        ...(options.capabilities
          ? { [CAPABILITIES_HEADER]: options.capabilities.join(',') }
          : {}),
        ...(options.notificationContractFingerprint
          ? { [NOTIFICATION_CONTRACT_HEADER]: options.notificationContractFingerprint }
          : {}),
      }
    : {}

  async function call<T>(
    method: string,
    apiPath: string,
    body?: unknown,
    /** Seconds the server was asked to hold the connection open. */
    serverWaitSeconds = 0,
    abort?: AbortSignal,
  ): Promise<T> {
    const startedAt = Date.now()
    try {
      const result = await callOnce<T>(method, apiPath, body, serverWaitSeconds, abort)
      logger?.debug('http.call', {
        method,
        path: apiPath,
        ok: true,
        duration_ms: Date.now() - startedAt,
      })
      return result
    } catch (err) {
      if (err instanceof RequestCancelledError) {
        logger?.debug('http.call', { method, path: apiPath, ok: false, cancelled: true, duration_ms: Date.now() - startedAt })
        throw err
      }
      logger?.error('http.call', {
        method,
        path: apiPath,
        ok: false,
        duration_ms: Date.now() - startedAt,
        ...(err instanceof ApiCallError
          ? { status: err.status, code: err.code, message: err.message, details: err.details }
          : { message: String(err) }),
      })
      throw err
    }
  }

  async function callOnce<T>(
    method: string,
    apiPath: string,
    body?: unknown,
    serverWaitSeconds = 0,
    abort?: AbortSignal,
  ): Promise<T> {
    // Without this, a server that accepts the connection and then never answers
    // hangs until the harness kills the whole hook — and the reply-poll deadline
    // cannot interrupt an individual fetch. The signal covers the
    // body read too, not just the response headers.
    const requestBudgetMs = budgetMs + serverWaitSeconds * 1000
    const remainingMs =
      options.deadlineAt === undefined
        ? requestBudgetMs
        : Math.max(1, options.deadlineAt - now())
    const limitMs = Math.max(1, Math.min(requestBudgetMs, remainingMs))
    const timeout = AbortSignal.timeout(limitMs)
    const signals = [timeout, ...(abort === undefined ? [] : [abort]), ...(options.signal === undefined ? [] : [options.signal])]
    const signal = signals.length === 1 ? timeout : AbortSignal.any(signals)
    let response: Response
    try {
      response = await fetch(`${root}${apiPath}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(bearer ? { authorization: bearer } : {}),
          ...clientHeaders,
        },
        signal,
        ...(bearer ? { redirect: 'error' as const } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (err) {
      // Cancelled by the caller, not timed out: say so, and log it as such.
      if ((abort?.aborted === true || options.signal?.aborted === true) && !timeout.aborted) {
        throw new RequestCancelledError(`${method} ${apiPath} was cancelled by the caller`)
      }
      throw networkFailure(err, root, limitMs)
    }
    if (!response.ok) {
      let parsed: ApiErrorBody | null = null
      try {
        parsed = (await response.json()) as ApiErrorBody
      } catch {
        // non-JSON body
      }
      throw new ApiCallError(
        response.status,
        parsed?.error.code ?? 'internal_error',
        parsed?.error.message ?? `Request failed with status ${response.status}`,
        parsed?.error.next_action ?? null,
        parsed?.error.details ?? null,
        parsed?.error.recovery_action ?? null,
      )
    }
    if (response.status === 204) return undefined as T
    try {
      return (await response.json()) as T
    } catch (err) {
      // A truncated or abandoned body is a transport failure, not a protocol
      // one: it must be retryable like any other, not surface as a raw abort.
      throw networkFailure(err, root, limitMs)
    }
  }

  return {
    beginPairing: (body) => call('POST', '/api/v1/pairings', body),
    pollPairing: (pairingId, pollVerifier) =>
      call('POST', `/api/v1/pairings/${encodeURIComponent(pairingId)}/poll`, {
        poll_verifier: pollVerifier,
      }),
    extendPairing: (pairingId, pollVerifier, lifetimeSeconds) =>
      call('POST', `/api/v1/pairings/${encodeURIComponent(pairingId)}/extend`, {
        poll_verifier: pollVerifier,
        ...(lifetimeSeconds === undefined ? {} : { lifetime_seconds: lifetimeSeconds }),
      }),
    requestPairingNotification: (pairingId, pollVerifier, email) => call('POST', `/api/v1/pairings/${encodeURIComponent(pairingId)}/notification`, { poll_verifier: pollVerifier, email }),
    revokeMachine: () => call('POST', '/api/v1/machine/revoke'),
    setupNotification: () => call('GET', '/api/v1/machine/setup-notification'),
    accessStatus: () => call('GET', '/api/v1/account/access'),
    accessRequest: () => call('GET', '/api/v1/account/alpha-access-request'),
    listDevices: () => call('GET', '/api/v1/devices'),
    listSounds: () => call('GET', '/api/v1/sounds'),
    capabilities: (platform = 'ios', appVersion, appBuild) => {
      const query = new URLSearchParams()
      if (appVersion !== undefined) query.set('app_version', appVersion)
      if (appBuild !== undefined) query.set('app_build', appBuild)
      const suffix = query.size > 0 ? `?${query.toString()}` : ''
      return call('GET', `/api/v1/capabilities/${encodeURIComponent(platform)}${suffix}`)
    },
    compatibility: () => call('GET', '/api/v1/compatibility'),
    submit: (body, waitSeconds) =>
      call('POST', `/api/v1/notifications?wait_seconds=${waitSeconds}`, body, waitSeconds),
    evidence: (requestId) => call('GET', `/api/v1/notifications/${encodeURIComponent(requestId)}`),
    replies: (requestId, { waitSeconds, afterSeq }) =>
      call(
        'GET',
        `/api/v1/notifications/${encodeURIComponent(requestId)}/replies?wait_seconds=${waitSeconds}&after_seq=${afterSeq}`,
        undefined,
        waitSeconds,
      ),
    closeReplies: (async (requestId: string, disposition?: CloseDisposition, retirement?: CloseRetirementState) => {
      const close = (body: CloseRepliesRequestT | undefined) => call<ListRepliesResponse | CloseRepliesResponse>(
        'POST',
        `/api/v1/notifications/${encodeURIComponent(requestId)}/replies/close`,
        body,
      )
      if (disposition === undefined) return close(undefined)
      if (retirement === undefined) return close({ disposition })
      try {
        return await close({ disposition, retirement })
      } catch (err) {
        // A service that predates `retirement` refuses it; the close itself
        // must still happen, with the service's older reading of it.
        if (err instanceof ApiCallError && err.status === 422 && err.code === 'invalid_request') return close({ disposition })
        throw err
      }
    }) as ApiClient['closeReplies'],
    putAgentAcknowledgement: (requestId, body) =>
      call<PutAgentAcknowledgementResponse>(
        'PUT',
        `/api/v1/notifications/${encodeURIComponent(requestId)}/agent-acknowledgement`,
        body,
      ),
    recordHarnessAnswer: (requestId, body) =>
      call<RecordHarnessAnswerResponse>('POST', `/api/v1/notifications/${encodeURIComponent(requestId)}/harness-answers`, body),
    upgradeAgentSessionLabel: (body) =>
      call<AgentSessionView>('POST', '/api/v1/agent-sessions/label/upgrade', body),
    putAgentSessionLabel: (body) =>
      call<AgentSessionView>('PUT', '/api/v1/agent-sessions/label', body),
    agentAcknowledgement: (requestId, { waitSeconds }) =>
      call<GetAgentAcknowledgementResponse>(
        'GET',
        `/api/v1/notifications/${encodeURIComponent(requestId)}/agent-acknowledgement?wait_seconds=${waitSeconds}`,
        undefined,
        waitSeconds,
      ),
    createMediaUpload: (body) => call('POST', '/api/v1/media', body),
    // Storage-observed bytes become authoritative before a send can reference
    // the upload; the caller's declared size is only a request.
    finalizeMediaUpload: (mediaId) =>
      call('POST', `/api/v1/media/${encodeURIComponent(mediaId)}/finalize`),
    uploadMedia: async (grant, bytes) => {
      let response: Response
      try {
        response = await fetch(grant.upload_url, {
          method: 'PUT',
          headers: grant.upload_headers,
          body: bytes,
          // Media can be large, so this gets its own allowance rather than the
          // per-request budget — but still a finite one.
          signal: AbortSignal.timeout(Math.max(budgetMs, 60_000)),
          // The grant names one exact destination and carries signed headers.
          // A redirect would replay both against an origin the server never
          // granted, so it is refused rather than followed.
          redirect: 'manual',
        })
      } catch (err) {
        throw new NetworkError(`Upload failed: ${String(err)}`)
      }
      if (response.status >= 300 && response.status < 400) {
        throw new NetworkError(
          `Upload redirect is refused, not followed: the grant's headers are signed for one exact destination`,
        )
      }
      if (!response.ok) {
        throw new NetworkError(`Upload rejected with status ${response.status}`)
      }
      // A successful storage PUT is not authorization to reference the media.
      // The idempotent finalize call makes the server inspect provider metadata
      // and commit authoritative quota before the command can use media_id.
      await call<FinalizeMediaUploadResponse>(
        'POST',
        `/api/v1/media/${encodeURIComponent(grant.media_id)}/finalize`,
      )
    },
    health: async () => {
      try {
        await call('GET', '/healthz')
        return true
      } catch {
        return false
      }
    },
    attend: (sessionId, body, { waitSeconds, signal }) =>
      call<AttendanceResponse>(
        'POST',
        `/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/attendance?wait_seconds=${waitSeconds}`,
        body,
        waitSeconds,
        signal,
      ),
    attendBatch: (body, { waitSeconds, signal }) =>
      call<AttendanceBatchResponse>(
        'POST',
        `/api/v1/agent-sessions/attendance?wait_seconds=${waitSeconds}`,
        body,
        waitSeconds,
        signal,
      ),
    claimDeliveryAttempt: (sessionId, body) =>
      call<ClaimDeliveryAttemptResponse>(
        'POST',
        `/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/delivery-attempts`,
        body,
      ),
    reportDeliveryAttempt: (attemptId, body) =>
      call<ReportDeliveryAttemptResponse>(
        'POST',
        `/api/v1/delivery-attempts/${encodeURIComponent(attemptId)}/report`,
        body,
      ),
    putSessionMessageAcknowledgement: (messageId, body) =>
      call<PutSessionMessageAcknowledgementResponse>(
        'PUT',
        `/api/v1/session-messages/${encodeURIComponent(messageId)}/agent-acknowledgement`,
        body,
      ),
    sessionMessageAcknowledgement: (messageId) =>
      call<GetSessionMessageAcknowledgementResponse>(
        'GET',
        `/api/v1/session-messages/${encodeURIComponent(messageId)}/agent-acknowledgement`,
      ),
  }
}
