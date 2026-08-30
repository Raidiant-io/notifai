import { NOTIFICATION_IMAGE_MAX_BYTES, type ListRepliesResponse } from '@raidiant/notifai-protocol'
import { sha256Hex } from '@raidiant/notifai-protocol/node'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isRetryableReplyPollError, type ApiClient } from './client.js'
import { fetchMediaUrl } from './url-policy.js'
import { buildSourceContext, inferInvocationContext } from './invocation-context.js'
import { readOrcaSessionTitle } from './orca-session-title.js'
import { type DraftInvocation, type SendFlags } from './send.js'
import { EXIT, reportError, type CommandDeps } from './commands-core.js'
import type { ActiveHarnessSession } from './commands-harness-context.js'

function managedSessionTitle(
  deps: CommandDeps,
  flags: Pick<SendFlags, 'sessionLabel'>,
  active: ActiveHarnessSession | null,
): string | undefined {
  if (active?.sessionLabel !== undefined) return active.sessionLabel
  if (
    active?.sessionId === undefined ||
    flags.sessionLabel !== undefined ||
    deps.env['NOTIFAI_SESSION_LABEL'] !== undefined
  ) {
    return undefined
  }
  try {
    return (deps.orcaSessionTitle ?? readOrcaSessionTitle)(deps.env)
  } catch {
    return undefined
  }
}

export function resolveDraftInvocation(
  deps: CommandDeps,
  flags: Pick<SendFlags, 'sessionId' | 'sessionLabel'>,
  active: ActiveHarnessSession | null,
): { ok: true; invocation: DraftInvocation } | { ok: false; error: string } {
  const inferred = inferInvocationContext(deps.cwd)
  const sessionTitle = managedSessionTitle(deps, flags, active)
  const source = buildSourceContext({
    env: deps.env,
    invocation: inferred,
    ...(flags.sessionId !== undefined ? { sessionId: flags.sessionId } : {}),
    ...(flags.sessionLabel !== undefined ? { sessionLabel: flags.sessionLabel } : {}),
    ...(active === null
      ? {}
      : {
          activeHarness: {
            harness: active.harness,
            ...(active.sessionId === undefined ? {} : { sessionId: active.sessionId }),
            ...(sessionTitle === undefined ? {} : { sessionLabel: sessionTitle }),
            ...(active.sessionLabelPending === true ? { sessionLabelPending: true } : {}),
          },
        }),
    now: (deps.now ?? Date.now)(),
  })
  if (!source.ok) return source
  if (source.generatedSessionLabel !== undefined) {
    deps.io.err(
      `Heads up (source.session_label): No semantic Agent Session title was available; using generated fallback "${source.generatedSessionLabel}". Pass --session-label with a concise task name when one is available.`,
    )
  }
  return {
    ok: true,
    invocation: {
      inferredProject: inferred.project,
      ...(source.source === undefined ? {} : { source: source.source }),
    },
  }
}

interface ReplyWaitOptions {
  timeoutSeconds: number
  afterSeq: number
  now?: (() => number) | undefined
  sleep?: ((milliseconds: number) => Promise<void>) | undefined
}

interface ReplyWaitResult {
  response: ListRepliesResponse
  timedOut: boolean
  /**
   * The wait ended while polls were failing, so silence is unproven: the user
   * may well have answered and we could not see it.
   */
  degraded: boolean
}

/** Loop over server-capped long polls until a reply arrives or the caller's deadline passes. */
export async function waitForReply(
  client: ApiClient,
  requestId: string,
  options: ReplyWaitOptions,
): Promise<ReplyWaitResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const deadline = now() + options.timeoutSeconds * 1000
  let lastResponse: ListRepliesResponse | null = null
  let lastTransientError: Error | null = null
  let consecutiveTransientErrors = 0
  let firstPoll = true

  while (firstPoll || now() < deadline) {
    firstPoll = false
    const remainingMs = Math.max(0, deadline - now())
    const waitSeconds = Math.min(25, Math.floor(remainingMs / 1000))
    try {
      const response = await client.replies(requestId, {
        waitSeconds,
        afterSeq: options.afterSeq,
      })
      lastResponse = response
      lastTransientError = null
      consecutiveTransientErrors = 0
      if (response.replies.length > 0) return { response, timedOut: false, degraded: false }

      const pauseMs = Math.min(250, Math.max(0, deadline - now()))
      if (pauseMs > 0) await sleep(pauseMs)
    } catch (err) {
      if (!isRetryableReplyPollError(err)) throw err
      lastTransientError = err instanceof Error ? err : new Error(String(err))
      consecutiveTransientErrors += 1
      const remainingAfterError = Math.max(0, deadline - now())
      if (remainingAfterError === 0) break
      const backoffMs = Math.min(
        250 * 2 ** (consecutiveTransientErrors - 1),
        2_000,
        remainingAfterError,
      )
      await sleep(backoffMs)
    }
  }

  // Never saw a successful poll: surface the fault so callers get EXIT.network
  // rather than a fake empty silence. The durable request is still on the
  // server; the typed recovery is `notifai replies <id>`.
  if (!lastResponse && lastTransientError) throw lastTransientError
  return {
    response:
      lastResponse ??
      ({
        request_id: requestId,
        reply_expires_at: null,
        agent_acknowledgement_required: false,
        agent_acknowledgement_text_required: false,
        agent_acknowledgement: null,
        replies: [],
      } satisfies ListRepliesResponse),
    timedOut: true,
    // A poll succeeded at some point, so we do not throw — but the last thing
    // we know is that we could not reach the server. Reporting that as a plain
    // "no reply" would let an agent treat an unseen refusal as consent.
    degraded: lastTransientError !== null,
  }
}

function acknowledgeInvocation(requestId: string, textRequired: boolean): string {
  return textRequired
    ? `notifai acknowledge ${requestId} --text <text>`
    : `notifai acknowledge ${requestId}`
}

export function acknowledgementCommand(
  requestId: string,
  required: boolean,
  textRequired: boolean,
  acknowledgement: ListRepliesResponse['agent_acknowledgement'],
  hasReply = true,
): string | null {
  return required && acknowledgement === null && hasReply
    ? acknowledgeInvocation(requestId, textRequired)
    : null
}

export function printAcknowledgementStatus(deps: CommandDeps, response: ListRepliesResponse): void {
  if (!response.agent_acknowledgement_required) {
    deps.io.out('Agent Acknowledgement: not required for this request.')
    return
  }
  const textRequired = response.agent_acknowledgement_text_required
  if (response.agent_acknowledgement !== null) {
    const recorded = `Agent Acknowledgement: recorded at ${response.agent_acknowledgement.created_at}`
    deps.io.out(
      response.agent_acknowledgement.text.length > 0
        ? `${recorded}: ${response.agent_acknowledgement.text}`
        : `${recorded}.`,
    )
    return
  }
  if (response.replies.length > 0) {
    deps.io.out('Agent Acknowledgement required.')
    deps.io.out(
      textRequired
        ? `next: Run \`${acknowledgeInvocation(response.request_id, true)}\` with concrete text saying what you will do because of the reply.`
        : `next: Run \`${acknowledgeInvocation(response.request_id, false)}\` so the user sees you read the reply; this account turned acknowledgement text off.`,
    )
    return
  }
  deps.io.out('Agent Acknowledgement: required after a user reply; no reply is recorded yet.')
}

const MEDIA_TYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/gif'> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
}

type UploadResult =
  | { ok: true; mediaId: string }
  /** `error: null` means `reportError` already said it; do not print it twice. */
  | { ok: false; error: string | null; exit: number }

/**
 * Read a remote image without buffering more than the server will accept.
 *
 * Content-Length is an early refusal, not trust: a lying header still hits
 * the byte cap while the body is read. Supported schemes stay http and https.
 */
export async function readCappedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | 'too-large'> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return 'too-large'
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const buf = new Uint8Array(await response.arrayBuffer())
    return buf.byteLength > maxBytes ? 'too-large' : buf
  }
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      return 'too-large'
    }
    chunks.push(value)
  }
  const out = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * `--image` accepts a media id, a local file path, or an http(s) URL.
 *
 * A remote URL is fetched under the media URL policy (`url-policy.ts`):
 * public HTTPS by default, every redirect hop re-validated, and non-public
 * destinations only through the User's `media_origins` — never a
 * repository's. `--image` values routinely arrive from an agent that read
 * them in a working tree, so the URL is hostile input until proven otherwise.
 */
export async function uploadImage(
  deps: CommandDeps,
  client: ApiClient,
  source: string,
  allowOrigins: readonly string[] = [],
): Promise<UploadResult> {
  let bytes: Uint8Array
  let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | undefined
  if (/^https?:\/\//.test(source)) {
    try {
      const fetched = await fetchMediaUrl(source, { allowOrigins }, deps.fetchImpl)
      if (!fetched.ok) return { ok: false, error: fetched.reason, exit: EXIT.usage }
      const response = fetched.response
      if (!response.ok) return { ok: false, error: `Could not fetch ${source} (${response.status}).`, exit: EXIT.usage }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
      mediaType = (['image/jpeg', 'image/png', 'image/gif'] as const).find((t) => t === contentType)
      const downloaded = await readCappedBytes(response, NOTIFICATION_IMAGE_MAX_BYTES)
      if (downloaded === 'too-large') {
        return {
          ok: false,
          error: `Remote image exceeds the ${NOTIFICATION_IMAGE_MAX_BYTES} byte media limit.`,
          exit: EXIT.usage,
        }
      }
      bytes = downloaded
    } catch (err) {
      return { ok: false, error: `Could not fetch ${source}: ${String(err)}`, exit: EXIT.network }
    }
  } else {
    if (!existsSync(source)) {
      return { ok: false, error: `--image: "${source}" is not a media id, file, or URL.`, exit: EXIT.usage }
    }
    bytes = new Uint8Array(readFileSync(source))
    mediaType = MEDIA_TYPES[path.extname(source).toLowerCase()]
  }
  if (!mediaType) {
    return { ok: false, error: 'Images must be JPEG, PNG, or GIF.', exit: EXIT.usage }
  }
  try {
    const grant = await client.createMediaUpload({
      media_type: mediaType,
      size_bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    })
    await client.uploadMedia(grant, bytes)
    return { ok: true, mediaId: grant.media_id }
  } catch (err) {
    // Every other API failure in this file goes through `reportError`, which
    // maps a revoked credential to the auth code, a server fault to the network
    // one and everything else to plain failure, and records it in the local
    // log with whatever next step the server named. This used to answer
    // `network` to all of them, so an image too large for the account exited
    // the same way an unreachable server did, and nothing about it was logged.
    return { ok: false, error: null, exit: reportError(deps, err) }
  }
}
