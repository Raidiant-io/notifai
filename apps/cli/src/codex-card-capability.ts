/** Installed capability for card-sourced registration and foreground delivery. */
import type { CommandDeps } from './commands-core.js'
import { codexTrustProblems, findInstallations, handlerEvent } from './install-hooks.js'

/**
 * The oldest Codex whose app-server Notifai links question cards on. A device
 * answer closes a card only by `turn/steer` with the exact `expectedTurnId`,
 * observed through `thread/turns/list`, on the server that owns the thread.
 * Older servers keep every ordinary Notifai question: the card stays in the
 * terminal and the answer returns by the ordinary route. The floor is raised
 * only with a reproduced card round trip on the new version; the daily
 * card canary in the public repository watches the newest Codex for drift.
 */
export const CODEX_CARD_VERSION_FLOOR = '0.163.0'

export type CodexCardVersionVerdict =
  | { supported: true; version: string }
  | { supported: false; reason: 'unknown_version' | 'below_floor'; version?: string }

interface ParsedVersion { numbers: [number, number, number]; prerelease: boolean }

function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/u.exec(value.trim())
  if (match === null) return null
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] !== undefined }
}

/**
 * Fail closed: a missing or unparseable version never links a card. A
 * prerelease of the floor itself is below it; a prerelease of a later version
 * is above it, matching SemVer precedence.
 */
export function codexCardVersionVerdict(version: unknown): CodexCardVersionVerdict {
  if (typeof version !== 'string' || version.trim() === '') return { supported: false, reason: 'unknown_version' }
  const actual = parseVersion(version)
  const floor = parseVersion(CODEX_CARD_VERSION_FLOOR)!
  if (actual === null) return { supported: false, reason: 'unknown_version', version }
  for (let index = 0; index < 3; index += 1) {
    if (actual.numbers[index]! > floor.numbers[index]!) return { supported: true, version }
    if (actual.numbers[index]! < floor.numbers[index]!) return { supported: false, reason: 'below_floor', version }
  }
  return actual.prerelease ? { supported: false, reason: 'below_floor', version } : { supported: true, version }
}

export function codexCardHooksReady(deps: Pick<CommandDeps, 'env' | 'hookAdapterHome' | 'hookPlatform'>): boolean {
  const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform)
    .filter(installation => installation.harness === 'codex')
  if (installations.some(installation => (installation.problems ?? []).length > 0)) return false
  const hooks = installations.map(installation => ({ ...installation, handlers: installation.handlers.filter(handler =>
    ['pre-tool-use', 'post-tool-use', 'user-prompt-submit'].includes(handlerEvent(handler.command) ?? '')) }))
  const handlers = hooks.flatMap(installation => installation.handlers)
  if (handlers.length !== 3 || !['PreToolUse', 'PostToolUse', 'UserPromptSubmit'].every(event =>
    handlers.some(handler => handler.event === event && handler.async !== true && handler.asyncRewake !== true &&
      (handler.matcher === undefined || handler.matcher === '*' ||
        (event === 'PreToolUse' && handler.matcher === 'request_user_input_async'))))) return false
  return codexTrustProblems(hooks, deps.env).length === 0
}
