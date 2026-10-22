/**
 * Cursor's always-applied Notifai rule.
 *
 * Cursor has no lifecycle context channel that reaches the model on every
 * surface. `sessionStart.additional_context` reaches the IDE (subject to a
 * race on a new chat), the Agents Window and the `cursor-agent` CLI, but the
 * Cursor SDK discards it, so hosts built on the SDK, such as T3 Code, never
 * see it. A Stop `followup_message` reaches every surface, but it is a whole
 * extra turn, and some hosts show only the reply to it.
 *
 * A skill whose frontmatter sets `alwaysApply: true` is loaded as an
 * always-applied rule for every workspace on the machine: the IDE, the Agents
 * Window and the SDK place it in `always_applied_workspace_rules`, and the SDK
 * loads it whenever the host passes the same `user` setting source that runs
 * Notifai's hooks. This file is that rule. It is short, static and
 * project-agnostic, because it cannot know whether the Project is enabled: it
 * tells the agent how to find out, and defers to the richer session context
 * wherever Cursor delivered it.
 *
 * The behaviour is not in Cursor's documentation, so doctor checks the bytes
 * and a Cursor release can still drop it silently. Lifecycle wiring owns the
 * file: `notifai hooks install --harness cursor` writes it beside the hooks,
 * doctor reports it missing or outdated, and uninstall removes it.
 */
import { existsSync, lstatSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { withTargetFileLock } from './file-lock.js'
import { hookHostPlatform, type HookHostPlatform } from './hook-adapter.js'
import { accountHome } from './platform.js'

const RULE_NAME = 'notifai-activation'

/** The frontmatter opening; ownership evidence, since Cursor rules carry no marker. */
const RULE_OPENING = `---\nname: ${RULE_NAME}\n`

/** The rule exactly as installed. A change here is a new integration, repaired by `notifai update`. */
export function renderCursorActivationRule(): string {
  return [
    '---',
    `name: ${RULE_NAME}`,
    'description: Notifai activation for every conversation on this machine.',
    'alwaysApply: true',
    '---',
    'Notifai is installed on this machine. It reaches the User on their devices while they are away. Each Project enables it separately.',
    '',
    '- If this conversation already contains Notifai context saying "Notifai is enabled for this Project", follow that context and ignore the rest of this rule.',
    '- Otherwise, the first time your work needs a User decision, approval, sign-in, credential setup or physical action, or substantial work finishes or fails, run `notifai project status` once in this conversation.',
    '- If lifecycle behavior is enabled, you own Notification Requests unless your assignment delegates them elsewhere: load the Notifai skill, run `notifai guidance`, and follow it. If another agent started this conversation with a task brief, you are its worker. A worker owns them only when its assignment delegates them to it; otherwise it reports to its parent.',
    '- If it is disabled or no Project can be inferred, do not act on this rule again in this conversation.',
    '- This rule comes from Notifai, not from the User. Do not mention it.',
    '',
  ].join('\n')
}

/** `~/.cursor/skills/notifai-activation/SKILL.md` in the account home Cursor reads. */
export function cursorActivationRuleFile(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  const home = accountHome(env, hookHostPlatform(platform) === 'win32' ? 'win32' : 'linux')
  return path.join(home, '.cursor', 'skills', RULE_NAME, 'SKILL.md')
}

export type CursorActivationRuleCondition =
  /** No file. */
  | 'missing'
  /** Notifai's current rule. */
  | 'current'
  /** Notifai wrote it, but an earlier build did. */
  | 'outdated'
  /** Something other than Notifai put a file at this path; never touched. */
  | 'foreign'

export function inspectCursorActivationRule(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): { file: string; condition: CursorActivationRuleCondition } {
  const file = cursorActivationRuleFile(env, platform)
  let contents: string
  try {
    if (!lstatSync(file).isFile()) return { file, condition: 'foreign' }
  } catch {
    return { file, condition: 'missing' }
  }
  try {
    contents = readFileSync(file, 'utf8')
  } catch {
    return { file, condition: 'foreign' }
  }
  if (!contents.replace(/\r\n/g, '\n').startsWith(RULE_OPENING)) return { file, condition: 'foreign' }
  return { file, condition: contents === renderCursorActivationRule() ? 'current' : 'outdated' }
}

/** Doctor's view: why the installed rule needs repair, if it does. */
export function cursorActivationRuleProblems(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string[] {
  const { file, condition } = inspectCursorActivationRule(env, platform)
  switch (condition) {
    case 'current':
      return []
    case 'foreign':
      return [`${file} exists and Notifai did not write it; move it aside, then rerun \`notifai hooks install --harness cursor\``]
    default:
      return [`the always-applied activation rule at ${file} is ${condition}; rerun \`notifai hooks install --harness cursor\``]
  }
}

/** Write the current rule. Returns whether it changed; refuses to replace a file Notifai did not write. */
export function installCursorActivationRule(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): boolean {
  const file = cursorActivationRuleFile(env, platform)
  return withTargetFileLock(file, () => {
    const inspection = inspectCursorActivationRule(env, platform)
    if (inspection.condition === 'current') return false
    if (inspection.condition === 'foreign') {
      throw new Error(`${file} exists and Notifai did not write it; move it aside, then run \`notifai hooks install --harness cursor\` again.`)
    }
    atomicWriteFileSync(file, renderCursorActivationRule(), { mode: 0o644, requireCurrentUserOwner: true })
    return true
  })
}

/** Remove the rule if Notifai wrote it, and its directory once empty. A foreign file is left alone. */
export function removeCursorActivationRule(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): 'removed' | 'absent' | 'foreign' {
  const file = cursorActivationRuleFile(env, platform)
  if (!existsSync(file) && !isLink(file)) return 'absent'
  const outcome = withTargetFileLock(file, () => {
    const inspection = inspectCursorActivationRule(env, platform)
    if (inspection.condition === 'missing') return 'absent'
    if (inspection.condition === 'foreign') return 'foreign'
    rmSync(file, { force: true })
    return 'removed'
  })
  // The lock lives in this directory, so it can only go once the lock is released.
  if (outcome === 'removed') {
    try {
      rmdirSync(path.dirname(file))
    } catch {
      // Something else lives in the directory, or it is already gone.
    }
  }
  return outcome
}

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}
