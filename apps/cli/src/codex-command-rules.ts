/**
 * Codex execution-policy rules that let it run every Notifai command.
 *
 * Codex's default sandbox has no network, and outside full-access mode Codex
 * asks before running a command outside it. A question, its wake-up and its
 * acknowledgement are all commands, so without a rule the first one waits at a
 * terminal nobody is watching and nothing reaches a device.
 *
 * Setup adds it, without asking, for a User who connects Codex, and says so in
 * its last message; `--no-codex-commands` leaves it out. It covers every
 * `notifai` command: one an agent needs that waits at a prompt nobody sees is
 * the failure the rule exists to prevent. An earlier Notifai wrote a rule for
 * a list of commands. `update --resume` rewrites that file, with no new
 * question, only when it is byte for byte what a Notifai build wrote; an
 * edited file may hold the User's own rules, so only setup replaces it.
 *
 * What Codex documents about rules, and what this module does with it:
 *
 * - Rules are experimental and may change, so `doctor` re-checks the written
 *   file with `codex execpolicy check` and reports a failing check as
 *   per-command approval, never as readiness.
 * - Codex scans `rules/` under every active config layer at startup only, so
 *   a session that started before the file existed keeps asking; `doctor`
 *   compares the session's start with the file's write time.
 * - A `prefix_rule` matches only a literal `notifai …` argument list. Codex
 *   splits a `bash -lc` script into commands only when it is plain words
 *   joined by `&&`, `||`, `;` or `|`; redirection, heredocs, `$(…)` and
 *   `VAR=…` leave the whole script unmatched, and so does a quoted value
 *   containing an unquoted escape or expansion, such as `'It'\''s'` or
 *   "$HOME". The skill joins single-quoted pieces with a double-quoted
 *   apostrophe (`'It'"'"'s'`), which preserves text and matches, and keeps
 *   real line breaks inside the quotes.
 * - The most restrictive decision wins, so a managed `forbidden` rule beats
 *   this file. `doctor` reports that as the organization's choice.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { atomicWriteFileSync } from './atomic-file.js'
import { withTargetFileLock } from './file-lock.js'
import type { HookHostPlatform } from './hook-adapter.js'
import { codexGlobalDir } from './install-hooks.js'
import type { ReadinessState } from './readiness.js'

const execute = promisify(execFile)

/** First line of the file; ownership evidence, since Codex rules carry no marker. */
export const CODEX_COMMAND_RULES_HEADER = '# Notifai command rules. Written by `notifai init --codex-commands`; removed by `notifai hooks uninstall --harness codex`.'

/** The program names the rule matches: `notifai`, and its Windows npm shims and native executable. */
export const CODEX_PROGRAM_NAMES: readonly string[] = ['notifai', 'notifai.cmd', 'notifai.ps1', 'notifai.exe']

/** What the file allows, as the consent and readiness text names it. */
export const CODEX_COMMANDS_PROSE = 'every Notifai command'

const CODEX_COMMAND_RULES_FILE_NAME = 'notifai.rules'

/** The command `doctor` re-checks the written file with; argument form the skill teaches. */
export const CODEX_RULE_CHECK_COMMAND: readonly string[] = [
  'notifai', 'send', '--kind', 'update', '--title', 'Rule check', '--summary', 'Codex can run this unprompted',
]

function starlarkList(items: readonly string[], indent: string): string {
  return items.map((item) => `${indent}${JSON.stringify(item)},`).join('\n')
}

/**
 * The file body. `match` and `not_match` are Codex's own inline unit tests:
 * Codex validates them when it loads the file, so a rule that stopped
 * matching the skill's argument form is refused rather than silently inert.
 */
export function renderCodexCommandRules(): string {
  return [
    CODEX_COMMAND_RULES_HEADER,
    '# Lets Codex run every Notifai command outside its sandbox without asking first. Rules match a literal `notifai …` argument list only.',
    'prefix_rule(',
    // Windows shells may name the npm shims or the native executable.
    `    pattern = [[${CODEX_PROGRAM_NAMES.map((name) => JSON.stringify(name)).join(', ')}]],`,
    '    decision = "allow",',
    '    justification = "Notifai notifications, answers and setup",',
    '    match = [',
    starlarkList([
      'notifai',
      'notifai send --kind done --title Users-can-create-accounts --summary Sign-up-works-on-staging',
      'notifai ask Which-environment --choice Staging --choice Production --json',
      'notifai receive',
      'notifai acknowledge req_123 --text Rolling-out-to-staging',
      'notifai status q_123 --json',
      'notifai replies --pending --json',
      'notifai close --pending',
      'notifai guidance',
      'notifai guidance set when-to-notify Only-when-blocked --local --yes',
      'notifai session status --json',
      'notifai session rename New-job',
      'notifai init --json --wait 240 --apps claude-code,codex',
      'notifai config set ask_notifications false',
      'notifai update',
      'notifai.cmd send --kind done --title A --summary B',
      'notifai.ps1 session status',
      'notifai.exe receive',
    ], '        '),
    '    ],',
    '    not_match = [',
    starlarkList([
      'npx notifai send --kind done --title A --summary B',
      'notifai-helper send',
    ], '        '),
    '    ],',
    ')',
    '',
  ].join('\n')
}

/** `rules/notifai.rules` in the running Codex installation's home (`CODEX_HOME` or `~/.codex`). */
export function codexCommandRulesFile(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  return path.join(codexGlobalDir(env, platform), 'rules', CODEX_COMMAND_RULES_FILE_NAME)
}

/**
 * SHA-256 of every rules file an earlier Notifai build wrote, oldest first.
 * Only these are rewritten unasked: any other text under Notifai's header may
 * hold a rule the User added. Append the current text's hash before changing
 * `renderCodexCommandRules`.
 */
export const SHIPPED_CODEX_RULES_SHA256: readonly string[] = [
  '07ae66e42a864f4f3f50daf8a8989c093f088b07024758f65f1de34f755e57b2',
  '4ff13a00f422a4644968ccc0ac68887b29b66a376580d148fe53ae6abd5bb3e3',
]

export type CodexCommandRulesCondition =
  /** No file. */
  | 'missing'
  /** Notifai's current file. */
  | 'current'
  /** Exactly the file an earlier Notifai build wrote. */
  | 'outdated'
  /** Notifai's header, but text no Notifai build wrote: someone edited it. */
  | 'edited'
  /** Something other than Notifai put a file at this path; never touched. */
  | 'foreign'

export interface CodexCommandRulesInspection {
  file: string
  condition: CodexCommandRulesCondition
  /** Wall-clock time of the last write, when a file exists. */
  writtenAt: number | null
}

export function inspectCodexCommandRules(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): CodexCommandRulesInspection {
  const file = codexCommandRulesFile(env, platform)
  let metadata
  try {
    metadata = lstatSync(file)
  } catch {
    return { file, condition: 'missing', writtenAt: null }
  }
  if (!metadata.isFile()) return { file, condition: 'foreign', writtenAt: metadata.mtimeMs }
  let contents: string
  try {
    contents = readFileSync(file, 'utf8')
  } catch {
    return { file, condition: 'foreign', writtenAt: metadata.mtimeMs }
  }
  const ours = contents.split(/\r?\n/, 1)[0] === CODEX_COMMAND_RULES_HEADER
  return {
    file,
    condition: !ours ? 'foreign' : contents === renderCodexCommandRules() ? 'current'
      : SHIPPED_CODEX_RULES_SHA256.includes(createHash('sha256').update(contents).digest('hex')) ? 'outdated' : 'edited',
    writtenAt: metadata.mtimeMs,
  }
}

export function codexCommandRulesInstalled(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): boolean {
  return inspectCodexCommandRules(env, platform).condition === 'current'
}

/** Write the current file. Returns whether it changed; refuses to replace a file Notifai did not write. */
export function installCodexCommandRules(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): boolean {
  const file = codexCommandRulesFile(env, platform)
  return withTargetFileLock(file, () => {
    const inspection = inspectCodexCommandRules(env, platform)
    if (inspection.condition === 'current') return false
    if (inspection.condition === 'foreign') {
      throw new Error(`${file} exists and Notifai did not write it; move it aside, then run \`notifai init --codex-commands\` again.`)
    }
    atomicWriteFileSync(file, renderCodexCommandRules(), { mode: 0o644, requireCurrentUserOwner: true })
    return true
  })
}

/**
 * Rewrite a rules file exactly as an earlier Notifai wrote it, the User's
 * earlier yes being the consent. A missing, foreign or edited file is left to
 * doctor and setup. Returns whether it changed.
 */
export function upgradeCodexCommandRules(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): boolean {
  if (inspectCodexCommandRules(env, platform).condition !== 'outdated') return false
  return installCodexCommandRules(env, platform)
}

/** Remove the file if Notifai wrote it. A foreign file at the path is left alone. */
export function removeCodexCommandRules(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): 'removed' | 'absent' | 'foreign' {
  const file = codexCommandRulesFile(env, platform)
  if (!existsSync(file) && !isDanglingLink(file)) return 'absent'
  return withTargetFileLock(file, () => {
    const inspection = inspectCodexCommandRules(env, platform)
    if (inspection.condition === 'missing') return 'absent'
    if (inspection.condition === 'foreign') return 'foreign'
    rmSync(file, { force: true })
    return 'removed'
  })
}

function isDanglingLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/** Every `.rules` file Codex loads from the same layer, ours first. */
export function codexLayerRuleFiles(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): { ours: string; siblings: string[] } {
  const ours = codexCommandRulesFile(env, platform)
  let siblings: string[] = []
  try {
    siblings = readdirSync(path.dirname(ours))
      .filter((name) => name.endsWith('.rules') && name !== CODEX_COMMAND_RULES_FILE_NAME)
      .sort()
      .map((name) => path.join(path.dirname(ours), name))
  } catch {
    siblings = []
  }
  return { ours, siblings }
}

export type CodexRuleDecision = 'allow' | 'prompt' | 'forbidden' | 'none'

export type CodexRuleCheckOutcome =
  | { decision: CodexRuleDecision; justifications: string[] }
  | { error: string }

/**
 * Run `codex execpolicy check --rules <file>… -- <command>`. Null when no
 * `codex` executable can be run here, which says nothing about the rule.
 */
export type CheckCodexCommandRules = (
  env: NodeJS.ProcessEnv,
  files: readonly string[],
  command: readonly string[],
) => Promise<CodexRuleCheckOutcome | null>

interface ExecpolicyReport {
  decision?: unknown
  matchedRules?: { prefixRuleMatch?: { decision?: unknown; justification?: unknown } }[]
}

export function parseExecpolicyReport(stdout: string): CodexRuleCheckOutcome {
  let parsed: ExecpolicyReport
  try {
    parsed = JSON.parse(stdout) as ExecpolicyReport
  } catch {
    return { error: `unreadable execpolicy output: ${stdout.trim().slice(0, 200)}` }
  }
  if (typeof parsed !== 'object' || parsed === null) return { error: 'unreadable execpolicy output' }
  const decision = parsed.decision
  const justifications = (parsed.matchedRules ?? [])
    .map((entry) => entry.prefixRuleMatch?.justification)
    .filter((value): value is string => typeof value === 'string')
  if (decision === 'allow' || decision === 'prompt' || decision === 'forbidden') return { decision, justifications }
  if (decision === undefined) return { decision: 'none', justifications }
  return { error: `unknown execpolicy decision ${JSON.stringify(decision)}` }
}

export const checkCodexCommandRules: CheckCodexCommandRules = async (env, files, command) => {
  try {
    const { stdout } = await execute(
      'codex',
      ['execpolicy', 'check', ...files.flatMap((file) => ['--rules', file]), '--', ...command],
      { env, timeout: 5_000, maxBuffer: 64_000 },
    )
    return parseExecpolicyReport(stdout)
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
    if (error.code === 'ENOENT') return null
    const detail = (error.stderr ?? error.stdout ?? error.message ?? String(err)).trim()
    return { error: detail.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-2).join(' ').slice(0, 300) || 'execpolicy check failed' }
  }
}

export const CODEX_COMMANDS_STATE_ID = 'codex-commands'
const TITLE = 'Codex command approval'
const PER_COMMAND_APPROVAL = 'approve Notifai commands when Codex asks'
const INSTALL_COMMAND = 'notifai init --codex-commands'

export interface CodexCommandReadinessInput {
  inspection: CodexCommandRulesInspection
  /** Our file alone; `undefined` when no check was attempted, `null` when Codex cannot be run here. */
  ownCheck?: CodexRuleCheckOutcome | null
  /** Our file with its siblings, where the layer's other rules can restrict it. */
  layerCheck?: CodexRuleCheckOutcome | null
  /** When the exact active Codex Agent Session started, if it has published state. */
  sessionStartedAt?: number | null
}

/** What the written rule means for this invocation; pure so every state is testable. */
export function codexCommandReadiness(input: CodexCommandReadinessInput): ReadinessState {
  const { inspection } = input
  const base = { id: CODEX_COMMANDS_STATE_ID, title: TITLE, harnesses: ['codex'] as const }
  const installRemedy = {
    by: 'cli' as const,
    summary: "on the User's yes, let Codex run every Notifai command outside its sandbox without asking first",
    command: INSTALL_COMMAND,
  }
  if (inspection.condition === 'missing') {
    return {
      ...base,
      status: 'optional-gap',
      detail: `not granted, so outside full-access mode Codex asks at the terminal before each Notifai command leaves its sandbox and a question cannot leave while you are away`,
      technical: { rules_file: inspection.file, condition: inspection.condition },
      remedy: installRemedy,
    }
  }
  if (inspection.condition === 'foreign') {
    return {
      ...base,
      status: 'optional-gap',
      detail: `${inspection.file} exists and Notifai did not write it, so the Notifai rule is not installed; ${PER_COMMAND_APPROVAL}`,
      technical: { rules_file: inspection.file, condition: inspection.condition },
      remedy: {
        by: 'user-here',
        summary: 'move that file aside, then let Notifai write its rule',
        command: INSTALL_COMMAND,
      },
    }
  }
  if (inspection.condition === 'outdated') {
    return {
      ...base,
      status: 'optional-gap',
      detail: `an earlier Notifai wrote ${inspection.file} for only some Notifai commands, so Codex may still ask before the others; setup rewrites it for every Notifai command`,
      technical: { rules_file: inspection.file, condition: inspection.condition },
      remedy: { ...installRemedy, summary: 'rewrite the Notifai rule the User already granted so it covers every Notifai command' },
    }
  }
  if (inspection.condition === 'edited') {
    return {
      ...base,
      status: 'optional-gap',
      detail: `${inspection.file} was changed after Notifai wrote it, so Notifai leaves it as it is and Codex may still ask before some Notifai commands; setup rewrites it for every Notifai command, dropping any rule added there`,
      technical: { rules_file: inspection.file, condition: inspection.condition },
      remedy: { ...installRemedy, summary: 'on the User\'s yes, rewrite the Notifai rule for every Notifai command; rules the User added to that file belong in another .rules file beside it' },
    }
  }
  const technical: Record<string, unknown> = { rules_file: inspection.file, condition: inspection.condition }
  const own = input.ownCheck
  if (own === null) {
    return {
      ...base,
      status: 'ready',
      detail: `Codex may run ${CODEX_COMMANDS_PROSE} outside its sandbox without asking first (${inspection.file}); no \`codex\` executable here to re-check the rule`,
      technical: { ...technical, verified: false },
    }
  }
  if (own !== undefined && 'error' in own) {
    return {
      ...base,
      status: 'optional-gap',
      detail: `this Codex rejected the Notifai rules file (${own.error}); Codex rules are experimental, so until a Notifai update matches this Codex, ${PER_COMMAND_APPROVAL}`,
      technical: { ...technical, verified: false, check_error: own.error },
    }
  }
  if (own !== undefined && own.decision !== 'allow') {
    return {
      ...base,
      status: 'optional-gap',
      detail: `this Codex does not apply the Notifai rule to \`${CODEX_RULE_CHECK_COMMAND.join(' ')}\` (decision: ${own.decision}); Codex rules are experimental, so until a Notifai update matches this Codex, ${PER_COMMAND_APPROVAL}`,
      technical: { ...technical, verified: false, decision: own.decision },
    }
  }
  const layer = input.layerCheck
  if (layer !== undefined && layer !== null && 'decision' in layer && layer.decision !== 'allow') {
    const reason = layer.justifications.filter((text) => text !== 'Notifai notifications and answers').join('; ')
    return {
      ...base,
      status: 'optional-gap',
      detail: layer.decision === 'forbidden'
        ? `your organization or another Codex rule blocks Notifai commands outside the sandbox${reason === '' ? '' : ` (${reason})`}; hooks keep working, and ${PER_COMMAND_APPROVAL}`
        : `another Codex rule in the same layer makes Notifai commands prompt${reason === '' ? '' : ` (${reason})`}; ${PER_COMMAND_APPROVAL}`,
      technical: { ...technical, verified: true, layer_decision: layer.decision },
    }
  }
  const verified = own !== undefined
  if (
    input.sessionStartedAt !== undefined &&
    input.sessionStartedAt !== null &&
    inspection.writtenAt !== null &&
    input.sessionStartedAt < inspection.writtenAt
  ) {
    return {
      ...base,
      status: 'optional-gap',
      detail: `the rule was written after this Codex session started, and Codex loads rules only at startup; in this session ${PER_COMMAND_APPROVAL}, and new Codex sessions will not ask. Do not end this session over it while one of its questions is waiting`,
      technical: { ...technical, verified, session_predates_rule: true, session_started_at: input.sessionStartedAt, rule_written_at: inspection.writtenAt },
    }
  }
  return {
    ...base,
    status: 'ready',
    detail: `Codex runs ${CODEX_COMMANDS_PROSE} outside its sandbox without asking first (${inspection.file}${verified ? ', re-checked with `codex execpolicy check`' : ''})`,
    technical: { ...technical, verified },
  }
}

/**
 * Assess the rule for `doctor` and `init`: inspect the file, re-check it with
 * the installed Codex, and compare it with the exact active session's start.
 */
export async function assessCodexCommandRules(
  env: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform | HookHostPlatform
    check?: CheckCodexCommandRules
    sessionStartedAt?: number | null
  } = {},
): Promise<ReadinessState> {
  const platform = options.platform ?? process.platform
  const inspection = inspectCodexCommandRules(env, platform)
  if (inspection.condition !== 'current') return codexCommandReadiness({ inspection })
  const check = options.check ?? checkCodexCommandRules
  const { ours, siblings } = codexLayerRuleFiles(env, platform)
  const ownCheck = await check(env, [ours], CODEX_RULE_CHECK_COMMAND)
  const layerCheck = ownCheck === null || 'error' in ownCheck || siblings.length === 0
    ? ownCheck
    : await check(env, [ours, ...siblings], CODEX_RULE_CHECK_COMMAND)
  return codexCommandReadiness({
    inspection,
    ownCheck,
    // A sibling file Codex cannot parse says nothing about ours.
    layerCheck: layerCheck !== null && 'error' in layerCheck ? ownCheck : layerCheck,
    sessionStartedAt: options.sessionStartedAt ?? null,
  })
}
