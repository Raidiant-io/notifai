import { claudeSessionHasSubagents } from './claude-subagent.js'
import type { CommandDeps } from './commands-core.js'
import { sourceContextHarnessSession } from './commands-harness-context.js'
import path from 'node:path'
import { conversationToken, guidanceGeneration, guidanceReads, installedSkill, pendingGuidanceChanges, recordGuidanceRead } from './guidance-currency.js'
import { resolveGuidance } from './guidance.js'
import { renderGuidance } from './guidance-render.js'
import { inferredProjectName } from './project-enablement.js'
import { shellQuote } from './reopen-terminal.js'
import { rootGuidanceDigest, rootGuidanceText } from './session-activation.js'

export function guidanceSessionNeedsToken(deps: Pick<CommandDeps, 'cwd' | 'env' | 'now'>): boolean {
  const active = sourceContextHarnessSession(deps.env, deps.cwd, (deps.now ?? Date.now)())
  return active?.harness === 'cursor' || (active?.harness === 'claude-code' && active.sessionId !== undefined &&
    claudeSessionHasSubagents(active.sessionId, deps.env, deps.cwd))
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

/** Capture the exact print transaction before resolving or emitting content. */
export function prepareCommandGuidanceRead(deps: CommandDeps, token?: string) {
  const session = commandGuidanceSession(deps, token)
  const generation = session === null ? 0 : guidanceGeneration(session, deps.env)
  const topics = resolveGuidance({ cwd: deps.cwd, env: deps.env })
  const text = rootGuidanceText(deps.cwd, deps.env, topics)
  return { session, generation, topics, text, digest: rootGuidanceDigest(deps.cwd, deps.env, text) }
}

export function recordCommandGuidanceRead(deps: CommandDeps, read: ReturnType<typeof prepareCommandGuidanceRead>, token?: string): boolean {
  const { session } = read
  if (session === null && (guidanceSessionNeedsToken(deps) || token !== undefined)) {
    deps.io.err('This shell cannot identify one conversation. Run `notifai guidance check`, then its read_command; pass the returned --guidance-token on Notification Requests.')
    return false
  }
  if (session === null) return true
  const recorded = recordGuidanceRead(session, deps.env, read.digest, read.text, read.generation, path.resolve(deps.cwd))
  if (!recorded) deps.io.err('Guidance changed while this read printed, so it was not recorded. Run `notifai guidance` again.')
  return recorded
}

/** "/x/app (Project "app")" or "/tmp/y (no Project)": where a read or a command applies. */
function folderLabel(folder: string, env: NodeJS.ProcessEnv): string {
  let project: string | null = null
  try { project = inferredProjectName(folder, env) } catch { /* a vanished folder names no Project */ }
  return `${folder} (${project === null ? 'no Project' : `Project ${JSON.stringify(project)}`})`
}

/**
 * Before any upload, registration or send. Notices cannot satisfy this check.
 * Any read this session holds of the exact guidance in force here admits the
 * command, wherever it was read. A refusal says which folder the command runs
 * in, where the session last read guidance, and the one command that reads it here.
 */
export function currentCommandGuidance(deps: CommandDeps, token?: string): { code: string; message: string; guidance: string; remedy: string } | null {
  const session = commandGuidanceSession(deps, token)
  if (session === null && !guidanceSessionNeedsToken(deps) && token === undefined) return null // ordinary scripts
  const digest = rootGuidanceDigest(deps.cwd, deps.env)
  const reads = session === null ? [] : guidanceReads(session, deps.env)
  if (reads.some(read => read.digest === digest)) return null
  const skill = installedSkill(deps.cwd, deps.env)
  const here = path.resolve(deps.cwd)
  const readHere = reads.some(read => read.folder === here)
  const elsewhere = readHere ? undefined : reads.findLast(read => read.folder !== undefined)?.folder
  const read = `notifai guidance${token === undefined ? '' : ` --session-token ${token}`}`
  const retry = `retry the same command${token === undefined ? '' : ` with --guidance-token ${token}`}`
  return {
    code: 'guidance_required',
    message: elsewhere !== undefined
      ? `This command runs in ${folderLabel(here, deps.env)}, where Notifai guidance differs from what this Agent Session read in ${folderLabel(elsewhere, deps.env)}. Nothing was sent or registered.`
      : readHere
        ? `Notifai guidance for ${folderLabel(here, deps.env)} changed after this Agent Session read it. Nothing was sent or registered.`
        : 'Current Notifai guidance must be read in this Agent Session before this Notification Request. Nothing was sent or registered.',
    guidance: renderGuidance(resolveGuidance({ cwd: deps.cwd, env: deps.env })),
    remedy: session === null
      ? 'Run `notifai guidance check`, read its skill_file when present, run its read_command, then retry this command with the returned --guidance-token.'
      : elsewhere !== undefined
        ? `Read the guidance for this folder: run \`cd ${shellQuote(here)} && ${read}\`, then ${retry} from ${here}. If this Notification Request belongs to the work in ${elsewhere}, run it from there instead.`
        : `${skill.file === null ? 'Repair the Notifai skill with `notifai init --skills`, then load its verified copy' : `Read ${JSON.stringify(skill.file)}`}; run \`${read}\`${readHere ? '' : ` in ${here}`}, then ${retry}.`,
  }
}

/** Changes for this exact conversation; ordinary scripts have no old context. */
export function commandGuidanceChanges(deps: CommandDeps, token?: string): string | undefined {
  const session = commandGuidanceSession(deps, token)
  return session === null ? undefined : pendingGuidanceChanges(session, deps.env, rootGuidanceText(deps.cwd, deps.env))
}
