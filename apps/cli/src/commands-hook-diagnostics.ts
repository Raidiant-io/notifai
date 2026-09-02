/** User-facing diagnosis and recovery guidance for hook readiness. */
import { type CommandDeps } from './commands-core.js'
import { type ActiveHarnessSession } from './commands-harness-context.js'
import { stopShapeProblems } from './commands-hook-shape.js'
import {
  HERMES_QUESTION_ROUTING_UNAVAILABLE,
  isHookInstallableHarness,
  questionRoutingCapability,
} from './harnesses.js'
import { inspectHookAdapter } from './hook-adapter.js'
import { HOOK_EVENTS } from './hook-events.js'
import { readSessionState } from './hook-session-state.js'
import {
  codexStopDefinitionFingerprint,
  codexTrustProblems,
  handlerEvent,
  type Installation,
} from './install-hooks.js'
export const CODEX_HOOK_APPROVAL_USER_ACTION = {
  code: 'codex_hook_approval_required',
  harness: 'codex',
  action: 'approve_or_enable_notifai_hooks',
  message: 'Open `/hooks` in Codex, approve or enable the Notifai handlers, then tell me when it is done. I will finish setup and verify a fresh session.',
} as const

export const CODEX_FRESH_SESSION_USER_ACTION = {
  code: 'codex_fresh_session_required',
  harness: 'codex',
  action: 'start_fresh_codex_session',
  message: 'Start one fresh Codex session, send one prompt in it, then retry the question.',
} as const

export const CODEX_STALE_STOP_DEFINITION_PROBLEM =
  'the exact Codex Agent Session activated before the current Stop definition; Codex can keep the earlier timeout in that session even when the file on disk is current. Start one fresh Codex session, send one prompt in it, then retry'

export const CODEX_STOP_DEFINITION_NOT_SINGULAR_PROBLEM =
  'the active Codex configuration does not contain exactly one Notifai Stop definition, so no singular turn-end owner can be proven'

export const CODEX_ACTIVATION_INSTALLATION_MISSING_PROBLEM =
  'the exact Codex Agent Session activation checkout has no matching hook installation'

/**
 * One fail-closed admission gate shared by every active harness route.
 * Finding a file is not readiness: the exact session, one current definition,
 * the stable adapter, a long enough Stop owner, and (for Codex) trust must all
 * be true before `ask` is allowed to create an answerable notification.
 */
export function activeQuestionRouteProblems(
  deps: CommandDeps,
  active: ActiveHarnessSession,
  installations: Installation[],
): string[] {
  const problems: string[] = []
  if (active.sessionId === undefined) {
    problems.push(
      `the active ${active.label} shell does not expose an exact session id; a project-level last-writer pointer can cross-wire two sessions. Use a blocking \`notifai send --reply\` question`,
    )
  }
  const capability = isHookInstallableHarness(active.harness)
    ? questionRoutingCapability(active.harness, deps.hookPlatform ?? process.platform)
    : HERMES_QUESTION_ROUTING_UNAVAILABLE
  if (capability.stopContinuation === 'unsupported') {
    problems.push(`${active.label}: ${capability.deliveryContract}`)
  }
  const matching = installations.filter(
    (installation) => installation.harness === active.harness,
  )
  if (active.harness === 'codex' && matching.length === 0) {
    problems.push(`${CODEX_ACTIVATION_INSTALLATION_MISSING_PROBLEM}: ${deps.cwd}`)
  }
  if (matching.length > 1) {
    problems.push(
      `${matching.length} ${active.label} definitions are active (${matching.map((entry) => entry.file).join(', ')}); keep either project or global routing`,
    )
  }
  for (const installation of matching) {
    for (const problem of installation.problems ?? []) {
      problems.push(`${installation.file}: ${problem}`)
    }
    for (const handler of installation.handlers) {
      const event = handlerEvent(handler.command)
      if (event !== null && !(HOOK_EVENTS as readonly string[]).includes(event)) {
        problems.push(
          `${handler.event} in ${installation.file} names the unsupported event ${event}; reinstall the ${active.label} hooks`,
        )
      }
    }
  }
  for (const problem of inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform).problems) {
    problems.push(problem)
  }
  for (const installation of matching) problems.push(...stopShapeProblems(installation, deps.hookPlatform))
  problems.push(...codexTrustProblems(matching, deps.env))
  if (active.harness === 'codex' && active.sessionId !== undefined) {
    const state = readSessionState(active.sessionId, deps.env)
    const currentFingerprint = codexStopDefinitionFingerprint(matching)
    if (matching.length === 1 && currentFingerprint === undefined) {
      problems.push(CODEX_STOP_DEFINITION_NOT_SINGULAR_PROBLEM)
    } else if (
      currentFingerprint !== undefined &&
      state.harness === 'codex' &&
      state.codex_stop_definition_fingerprint !== currentFingerprint
    ) {
      problems.push(CODEX_STALE_STOP_DEFINITION_PROBLEM)
    }
  }
  return [...new Set(problems)]
}

/** The least disruptive verified way to make each installed adapter run once. */
export function hookActivationAdvice(installations: Installation[]): string {
  const harnesses = new Set(installations.map((installation) => installation.harness))
  const advice: string[] = []
  if (
    installations.some(
      (installation) => installation.harness === 'claude-code' && !installation.global,
    )
  ) {
    advice.push('Claude Code: start one fresh session, send one prompt, then run `notifai doctor`')
  }
  if (
    installations.some(
      (installation) => installation.harness === 'claude-code' && installation.global,
    )
  ) {
    advice.push('Claude Code global hooks: start one fresh session, send one prompt, then run `notifai doctor`')
  }
  if (
    installations.some(
      (installation) => installation.harness === 'cursor' && !installation.global,
    )
  ) {
    advice.push(
      'Cursor: start one fresh conversation, send one prompt, finish its first turn, then run `notifai doctor`',
    )
  }
  if (
    installations.some(
      (installation) => installation.harness === 'cursor' && installation.global,
    )
  ) {
    advice.push('Cursor global hooks: start one fresh conversation, send one prompt, finish its first turn, then run `notifai doctor`')
  }
  if (harnesses.has('codex')) {
    advice.push(
      'Codex: approve the Notifai handlers in `/hooks` if asked, start one fresh session, send one prompt, then run `notifai doctor`',
    )
  }
  if (harnesses.has('opencode')) {
    advice.push(
      'OpenCode: restart it, then send one prompt; plugins load at startup, but non-blocking question continuation is intentionally unsupported',
    )
  }
  if (harnesses.has('openclaw')) {
    advice.push(
      'OpenClaw: restart the Gateway, then send one prompt; plugins load at startup, but non-blocking question continuation is intentionally unsupported',
    )
  }
  return `${advice.join('. ')}.`
}
