import { claudeSessionHasSubagents } from './claude-subagent.js'
import type { CommandDeps } from './commands-core.js'
import { sourceContextHarnessSession } from './commands-harness-context.js'
import { conversationToken, guidanceRead, installedSkill, recordGuidanceRead } from './guidance-currency.js'
import { resolveGuidance } from './guidance.js'
import { renderGuidance } from './guidance-render.js'
import { rootGuidanceDigest } from './session-activation.js'

export function guidanceSessionNeedsToken(deps: CommandDeps): boolean {
  const active = sourceContextHarnessSession(deps.env, deps.cwd, (deps.now ?? Date.now)())
  return active?.harness === 'cursor' || (active?.harness === 'claude-code' && active.sessionId !== undefined &&
    claudeSessionHasSubagents(active.sessionId, deps.env))
}

export function commandGuidanceOwner(deps: CommandDeps): string {
  const active = sourceContextHarnessSession(deps.env, deps.cwd, (deps.now ?? Date.now)())
  return active?.sessionId ?? active?.harness ?? 'unidentified'
}

export function commandGuidanceSession(deps: CommandDeps, token?: string): string | null {
  if (token !== undefined) {
    const valid = conversationToken(deps.env, token, commandGuidanceOwner(deps))
    return valid === null ? null : `conversation/${valid}`
  }
  if (guidanceSessionNeedsToken(deps)) return null
  return sourceContextHarnessSession(deps.env, deps.cwd, (deps.now ?? Date.now)())?.sessionId ?? null
}

export function recordCommandGuidanceRead(deps: CommandDeps, token?: string): boolean {
  const session = commandGuidanceSession(deps, token)
  if (session === null && (guidanceSessionNeedsToken(deps) || token !== undefined)) {
    deps.io.err('This shell cannot identify one conversation. Run `notifai guidance check`, then its read_command; pass the returned --guidance-token on Notification Requests.')
    return false
  }
  return session === null || recordGuidanceRead(session, deps.env, rootGuidanceDigest(deps.cwd, deps.env))
}

/** Before any upload, registration or send. Notices cannot satisfy this check. */
export function currentCommandGuidance(deps: CommandDeps, token?: string): { code: string; message: string; guidance: string; remedy: string } | null {
  const session = commandGuidanceSession(deps, token)
  if (session === null && !guidanceSessionNeedsToken(deps) && token === undefined) return null // ordinary scripts
  const digest = rootGuidanceDigest(deps.cwd, deps.env)
  if (session !== null && guidanceRead(session, deps.env) === digest) return null
  const skill = installedSkill(deps.cwd, deps.env)
  return {
    code: 'guidance_required',
    message: 'Current Notifai guidance must be read in this Agent Session before this Notification Request. Nothing was sent or registered.',
    guidance: renderGuidance(resolveGuidance({ cwd: deps.cwd, env: deps.env })),
    remedy: session === null
      ? 'Run `notifai guidance check`, read its skill_file when present, run its read_command, then retry this command with the returned --guidance-token.'
      : `${skill.file === null ? 'Repair the Notifai skill with `notifai init --skills`, then load its verified copy' : `Read ${JSON.stringify(skill.file)}`}; run \`notifai guidance${token === undefined ? '' : ` --session-token ${token}`}\`, then retry the same command${token === undefined ? '' : ` with --guidance-token ${token}`}.`,
  }
}
