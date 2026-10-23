import type { CommandDeps } from './commands-core.js'
import { sourceContextHarnessSession } from './commands-harness-context.js'
import { conversationToken, guidanceRead, installedSkill, recordGuidanceRead } from './guidance-currency.js'
import { resolveGuidance } from './guidance.js'
import { renderGuidance } from './guidance-render.js'
import { rootGuidanceDigest } from './session-activation.js'

export function commandGuidanceSession(deps: CommandDeps, token?: string): string | null {
  const active = sourceContextHarnessSession(deps.env, deps.cwd, (deps.now ?? Date.now)())
  if (active?.sessionId !== undefined) return active.sessionId
  if (active?.harness !== 'cursor' && token === undefined) return null
  const valid = token === undefined ? null : conversationToken(deps.env, token)
  return valid === null ? null : `conversation/${valid}`
}

export function recordCommandGuidanceRead(deps: CommandDeps, token?: string): boolean {
  const session = commandGuidanceSession(deps, token)
  return session === null || recordGuidanceRead(session, deps.env, rootGuidanceDigest(deps.cwd, deps.env))
}

/** Before any upload, registration or send. Notices cannot satisfy this check. */
export function currentCommandGuidance(deps: CommandDeps, token?: string): { code: string; message: string; guidance: string; remedy: string } | null {
  const active = sourceContextHarnessSession(deps.env, deps.cwd, (deps.now ?? Date.now)())
  const session = commandGuidanceSession(deps, token)
  if (session === null && active?.harness !== 'cursor' && token === undefined) return null // ordinary scripts
  const digest = rootGuidanceDigest(deps.cwd, deps.env)
  if (session !== null && guidanceRead(session, deps.env) === digest) return null
  const skill = installedSkill(deps.cwd, deps.env)
  return {
    code: 'guidance_required',
    message: 'Current Notifai guidance must be read in this Agent Session before this Notification Request. Nothing was sent or registered.',
    guidance: renderGuidance(resolveGuidance({ cwd: deps.cwd, env: deps.env })),
    remedy: `${skill.file === null ? 'Load the Notifai skill' : `Read ${JSON.stringify(skill.file)}`}; run \`notifai guidance${token === undefined ? '' : ` --session-token ${token}`}\`, then retry the same command. Cursor without a token: first run \`notifai guidance check\` and use only the token it returns.`,
  }
}
