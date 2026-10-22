/**
 * Codex execution-policy rules for the Notifai commands an away User depends on.
 *
 * Codex's default sandbox has no network, and outside full-access mode Codex
 * asks before running a command outside it. A question, its wake-up and its
 * acknowledgement are all commands, so without a rule the first one waits at a
 * terminal nobody is watching and nothing reaches a device.
 *
 * The rule is the User's to grant: setup offers it and writes it only on a
 * yes. It covers sending, asking, reading and acknowledging. Setup,
 * configuration, guidance edits, logs and sign-out keep their prompt.
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
 *   that is not one plain string, such as `'It'\''s'` or `"$HOME"`. The skill
 *   therefore passes every text value, a Markdown body included, inline in
 *   single quotes, with real line breaks inside them.
 * - The most restrictive decision wins, so a managed `forbidden` rule beats
 *   this file. `doctor` reports that as the organization's choice.
 */
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { atomicWriteFileSync } from './atomic-file.js'
import { withTargetFileLock } from './file-lock.js'
import type { HookHostPlatform } from './hook-adapter.js'
import { codexGlobalDir } from './install-hooks.js'
import type { ReadinessState } from './readiness.js'

const execute = promisify(execFile)

/** The Notifai subcommands the rule lets Codex run outside its sandbox unprompted. */
export const CODEX_ALLOWED_COMMANDS: readonly string[] = [
  'send',
  'ask',
  'receive',
  'acknowledge',
  'status',
  'replies',
  'close',
]

/** First line of the file; ownership evidence, since Codex rules carry no marker. */
export const CODEX_COMMAND_RULES_HEADER = '# Notifai command rules. Written by `notifai init --codex-commands`; removed by `notifai hooks uninstall --harness codex`.'

/** Every command the file allows, as the consent and readiness text names them. */
export const CODEX_COMMANDS_PROSE = `${[...CODEX_ALLOWED_COMMANDS, 'guidance'].join(', ')} and session rename`

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
    '# Lets Codex run the Notifai commands an away User depends on outside its sandbox without asking first.',
    '# Setup, configuration and guidance edits keep their prompt. Rules match a literal `notifai …` argument list only.',
    'prefix_rule(',
    `    pattern = ["notifai", [${CODEX_ALLOWED_COMMANDS.map((command) => JSON.stringify(command)).join(', ')}]],`,
    '    decision = "allow",',
    '    justification = "Notifai notifications and answers",',
    '    match = [',
    starlarkList([
      'notifai send --kind done --title Users-can-create-accounts --summary Sign-up-works-on-staging',
      'notifai ask Which-environment --choice Staging --choice Production --json',
      'notifai receive',
      'notifai acknowledge req_123 --text Rolling-out-to-staging',
      'notifai status q_123 --json',
      'notifai replies --pending --json',
      'notifai close --pending',
    ], '        '),
    '    ],',
    '    not_match = [',
    starlarkList([
      'notifai init --hooks --json',
      'notifai config set ask_notifications false',
      'notifai hooks uninstall --harness codex',
      'notifai update',
      'notifai logout',
    ], '        '),
    '    ],',
    ')',
    'prefix_rule(',
    '    pattern = ["notifai", "guidance"],',
    '    decision = "allow",',
    '    justification = "Reads Notifai guidance",',
    '    match = ["notifai guidance"],',
    ')',
    '# A prefix rule cannot exclude a longer prefix, so guidance edits get their prompt back explicitly.',
    'prefix_rule(',
    '    pattern = ["notifai", "guidance", ["set", "unset"]],',
    '    decision = "prompt",',
    '    justification = "Guidance edits are the User\'s standing word and keep their prompt",',
    '    match = ["notifai guidance set when-to-notify Only-when-blocked --local --yes", "notifai guidance unset when-to-notify --local --yes"],',
    ')',
    'prefix_rule(',
    '    pattern = ["notifai", "session", "rename"],',
    '    decision = "allow",',
    '    justification = "Renames the Agent Session",',
    '    match = ["notifai session rename New-job"],',
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

export type CodexCommandRulesCondition =
  /** No file. */
  | 'missing'
  /** Notifai's current file. */
  | 'current'
  /** Notifai wrote it, but an earlier build did. */
  | 'outdated'
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
    condition: !ours ? 'foreign' : contents === renderCodexCommandRules() ? 'current' : 'outdated',
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
    summary: "on the User's yes, let Codex run the Notifai commands an away User depends on outside its sandbox without asking first",
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
      detail: `an earlier Notifai wrote ${inspection.file}; refresh it so it matches the commands this build teaches`,
      technical: { rules_file: inspection.file, condition: inspection.condition },
      remedy: { ...installRemedy, summary: 'rewrite the Codex rule for this Notifai build' },
    }
  }
  const technical: Record<string, unknown> = { rules_file: inspection.file, condition: inspection.condition }
  const own = input.ownCheck
  if (own === null) {
    return {
      ...base,
      status: 'ready',
      detail: `Codex may run the Notifai ${CODEX_COMMANDS_PROSE} commands outside its sandbox without asking first (${inspection.file}); no \`codex\` executable here to re-check the rule`,
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
    detail: `Codex runs the Notifai ${CODEX_COMMANDS_PROSE} commands outside its sandbox without asking first (${inspection.file}${verified ? ', re-checked with `codex execpolicy check`' : ''})`,
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
