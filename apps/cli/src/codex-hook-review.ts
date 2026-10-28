/**
 * `notifai doctor codex`: help the User approve Notifai's Codex hooks in every
 * Codex home Notifai knows they use.
 *
 * Codex keys hook approval by its home's path, so a Codex account in its own
 * home (T3 Code's extra accounts, a User's own `CODEX_HOME`) needs its own
 * approval, and apps that run Codex for the User offer no hook review. This
 * command finds those homes, asks Codex which of Notifai's hooks wait there,
 * and opens **Codex's own** review screen in each one, one after another.
 *
 * The line it never crosses: Notifai never approves its own hooks. It writes
 * no `hooks.state`, passes no trust override, and has no "approve all" of its
 * own. Codex shows the decision and Codex records it; Notifai only reads the
 * result afterwards. Run by an agent, it launches nothing and prints the one
 * command for the User instead.
 *
 * Discovery stays conservative: `~/.codex`, this shell's `CODEX_HOME`, and
 * homes Notifai's own records saw a Codex thread run in. It reads no other
 * app's private settings, and never starts Codex in a folder that does not
 * already exist as a Codex home.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync, ensurePrivateDirectory } from './atomic-file.js'
import { listCodexHooks, codexTrustFindingsFrom, type ListCodexHooks } from './codex-hooks-list.js'
import { CODEX_REVIEW_COMMAND, codexOnHomeCommand } from './codex-surface.js'
import { EXIT, type CommandDeps } from './commands-core.js'
import { inheritedHarnessMarkers } from './commands-harness-context.js'
import { stateDir } from './config.js'
import { type HookHostPlatform } from './hook-adapter.js'
import {
  findInstallations,
  harnessAccountHome,
  separateCodexHome,
  type CodexTrustFinding,
  type Installation,
} from './install-hooks.js'

export { CODEX_REVIEW_COMMAND }

/** Where Notifai learned of a home. */
export type CodexHomeOrigin = 'default' | 'shell' | 'seen'

export interface CodexReviewHome {
  home: string
  origin: CodexHomeOrigin
  /** `~/.codex`: Codex's own default, which the ChatGPT app and editor use too. */
  isDefault: boolean
  /** Orca gives each account its own home and copies `~/.codex`'s approval into it. */
  host: 'orca' | 't3' | null
}

export type CodexHomeState = 'approved' | 'review' | 'off' | 'not-installed'

export interface CodexHomeReview extends CodexReviewHome {
  label: string
  state: CodexHomeState
  findings: CodexTrustFinding[]
  /** The home holds its own Codex sign-in (`auth.json`). */
  login: boolean
}

/** What starts Codex's review in one home. */
export interface CodexReviewLaunch {
  home: string
  args: string[]
  /** Only `CODEX_HOME` differs from this process's environment; undefined removes it. */
  codexHome: string | undefined
  /** The same launch typed by hand, for when Notifai cannot start it. */
  display: string
}

export interface CodexReviewSeams {
  /** Codex's executable on PATH; null when the Codex CLI is not installed. */
  codexPath?: string | null
  /** Starts Codex in the foreground and resolves when the User leaves it. */
  launch?: (launch: CodexReviewLaunch, executable: string) => Promise<'exited' | 'failed'>
  /** Notifai's Codex installations for a home's environment. */
  installations?: (env: NodeJS.ProcessEnv) => Installation[]
}

const REMEMBERED = 'codex-homes.json'
const REMEMBERED_LIMIT = 16

function rememberedFile(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), REMEMBERED)
}

function readRemembered(env: NodeJS.ProcessEnv): string[] {
  try {
    const value = JSON.parse(readFileSync(rememberedFile(env), 'utf8')) as { homes?: unknown }
    return Array.isArray(value.homes) ? value.homes.filter((home): home is string => typeof home === 'string' && path.isAbsolute(home)) : []
  } catch {
    return []
  }
}

/**
 * Note the separate Codex home this shell runs in, when a reminder is about to
 * name `notifai doctor codex`: the User may run it from a terminal that knows
 * nothing of that home. Notifai's own state only; never throws.
 */
export function rememberCodexHome(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): void {
  const home = separateCodexHome(env, platform)
  if (home === null || !path.isAbsolute(home)) return
  try {
    const homes = readRemembered(env).filter((entry) => entry !== home)
    homes.unshift(home)
    ensurePrivateDirectory(stateDir(env))
    atomicWriteFileSync(rememberedFile(env), `${JSON.stringify({ homes: homes.slice(0, REMEMBERED_LIMIT) })}\n`)
  } catch { /* A reminder never fails for want of this note. */ }
}

/** Homes recorded for Codex threads Notifai attended (beta.1 and later record each thread's home). */
function attendedHomes(env: NodeJS.ProcessEnv): string[] {
  const directory = path.join(stateDir(env), 'sessions')
  let names: string[]
  try { names = readdirSync(directory).filter((name) => name.endsWith('.attendance.json')) } catch { return [] }
  const homes = new Set<string>()
  for (const name of names) {
    try {
      const status = JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as { adoption?: { codex_home?: unknown } }
      const home = status.adoption?.codex_home
      if (typeof home === 'string' && path.isAbsolute(home)) homes.add(home)
    } catch { /* A half-written or foreign file names no home. */ }
  }
  return [...homes]
}

const ORCA_HOME = /[\\/]orca[\\/]codex-accounts[\\/]/i
const T3_HOME = /[\\/]providers[\\/]codex[\\/][^\\/]+[\\/]shadow[\\/]?$/i

function isCodexHome(home: string): boolean {
  try {
    return statSync(home).isDirectory() &&
      (existsSync(path.join(home, 'config.toml')) || existsSync(path.join(home, 'hooks.json')))
  } catch {
    return false
  }
}

function canonical(home: string): string {
  try { return realpathSync(home) } catch { return path.resolve(home) }
}

/**
 * The Codex homes to check, default first. Only folders that already are
 * Codex homes: starting Codex in a retired or not-yet-created one would make
 * it one.
 */
export function codexReviewHomes(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): CodexReviewHome[] {
  const defaultHome = path.join(harnessAccountHome(env, platform), '.codex')
  const shell = env['CODEX_HOME']?.trim() ?? ''
  const candidates: { home: string; origin: CodexHomeOrigin }[] = [
    { home: defaultHome, origin: 'default' },
    ...(shell === '' ? [] : [{ home: shell, origin: 'shell' as const }]),
    ...readRemembered(env).map((home) => ({ home, origin: 'seen' as const })),
    ...attendedHomes(env).map((home) => ({ home, origin: 'seen' as const })),
  ]
  const seen = new Set<string>()
  const defaultKey = canonical(defaultHome)
  const homes: CodexReviewHome[] = []
  for (const candidate of candidates) {
    const key = canonical(candidate.home)
    if (seen.has(key) || !isCodexHome(candidate.home)) continue
    seen.add(key)
    const isDefault = key === defaultKey
    homes.push({
      home: isDefault ? defaultHome : candidate.home,
      origin: isDefault ? 'default' : candidate.origin,
      isDefault,
      host: ORCA_HOME.test(candidate.home) ? 'orca' : T3_HOME.test(candidate.home) ? 't3' : null,
    })
  }
  return homes
}

/** The environment Codex runs with in `home`. */
export function codexHomeEnv(review: CodexReviewHome, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  if (review.isDefault) delete next['CODEX_HOME']
  else next['CODEX_HOME'] = review.home
  return next
}

/**
 * How to open Codex's own review in a home. A home with its own sign-in opens
 * it with plain `codex`. A home without one (T3 Code supplies its accounts'
 * tokens itself) would show Codex's sign-in screen first, so it starts with
 * the built-in `ollama` provider, which needs none: it changes only that
 * session's model, which reviewing hooks never uses, and persists nothing.
 */
export function codexReviewLaunch(
  review: Pick<CodexReviewHome, 'home' | 'isDefault'>,
  login: boolean,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): CodexReviewLaunch {
  const args = login ? [] : ['-c', 'model_provider=ollama']
  const codexHome = review.isDefault ? undefined : review.home
  const command = ['codex', ...args].join(' ')
  return {
    home: review.home,
    args,
    codexHome,
    display: codexHome === undefined ? command : codexOnHomeCommand(codexHome, platform === 'win32' ? 'win32' : 'posix', command),
  }
}

function homeLabel(review: CodexReviewHome, env: NodeJS.ProcessEnv, platform: NodeJS.Platform | HookHostPlatform): string {
  const account = harnessAccountHome(env, platform)
  const shown = review.home.startsWith(account + path.sep) ? `~${review.home.slice(account.length)}` : review.home
  if (review.isDefault) return shown
  if (review.host === 't3') return `T3 Code account (${shown})`
  if (review.host === 'orca') return `Orca account (${shown})`
  return review.origin === 'shell' ? `this shell's CODEX_HOME (${shown})` : shown
}

export async function assessCodexHome(
  review: CodexReviewHome,
  deps: CommandDeps,
  options: { list?: ListCodexHooks | null; installations?: (env: NodeJS.ProcessEnv) => Installation[] } = {},
): Promise<CodexHomeReview> {
  const platform = deps.hookPlatform ?? process.platform
  const env = codexHomeEnv(review, deps.env)
  const label = homeLabel(review, deps.env, platform)
  const login = existsSync(path.join(review.home, 'auth.json'))
  const installations = (options.installations ?? ((homeEnv) => findInstallations(homeEnv, deps.hookAdapterHome, deps.hookPlatform)))(env)
    .filter((installation) => installation.harness === 'codex')
  if (installations.length === 0) return { ...review, label, state: 'not-installed', findings: [], login }
  let listed = null
  if (options.list !== null) {
    try { listed = await (options.list ?? deps.codexHooksList ?? listCodexHooks)(env, deps.cwd) } catch { listed = null }
  }
  const findings = codexTrustFindingsFrom(installations, env, listed)
  const state: CodexHomeState = findings.length === 0 ? 'approved'
    : findings.some((finding) => finding.state === 'disabled') ? 'off' : 'review'
  return { ...review, label, state, findings, login }
}

/** The Codex CLI on PATH, as Windows or a POSIX shell would find it. */
export function findCodexExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string | null {
  const windows = platform === 'win32'
  const directories = (env['PATH'] ?? env['Path'] ?? '').split(windows ? ';' : ':').filter((entry) => entry !== '')
  const extensions = windows ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '') : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `codex${extension.toLowerCase()}`)
      try { if (statSync(candidate).isFile()) return candidate } catch { /* not here */ }
    }
  }
  return null
}

/**
 * Codex in the foreground, on this terminal. Ctrl+C belongs to Codex while it
 * runs; this process waits for it to end.
 */
async function launchInForeground(launch: CodexReviewLaunch, executable: string): Promise<'exited' | 'failed'> {
  const env = { ...process.env }
  if (launch.codexHome === undefined) delete env['CODEX_HOME']
  else env['CODEX_HOME'] = launch.codexHome
  // Windows runs an npm-installed `codex.cmd` only through its shell; the arguments are fixed words.
  const shell = /\.(cmd|bat)$/i.test(executable)
  const ignore = () => { /* Codex handles the interrupt. */ }
  process.on('SIGINT', ignore)
  try {
    return await new Promise((resolve) => {
      const child = spawn(shell ? `"${executable}"` : executable, launch.args, { stdio: 'inherit', env, shell })
      child.on('error', () => resolve('failed'))
      child.on('exit', () => resolve('exited'))
    })
  } finally {
    process.off('SIGINT', ignore)
  }
}

function pendingLine(review: CodexHomeReview): string {
  const waiting = review.findings.filter((finding) => finding.state !== 'disabled').length
  const off = review.findings.length - waiting
  const count = (n: number) => `${n} Notifai ${n === 1 ? 'hook' : 'hooks'}`
  const parts = [
    ...(waiting > 0 ? [`${count(waiting)} new or changed`] : []),
    ...(off > 0 ? [`${count(off)} turned off`] : []),
  ]
  return `${review.label}: ${parts.join(', ')}`
}

function howToApprove(review: CodexHomeReview): string {
  return review.state === 'off'
    ? "Codex opens here: type /hooks, turn Notifai's hooks on and approve them, then press Ctrl+C to come back."
    : 'Codex opens its own hook review here: choose "Trust all and continue", then press Ctrl+C to come back.'
}

/** Run by an agent, or by the User without a terminal: what to do, and nothing launched. */
function agentReport(deps: CommandDeps, pending: CodexHomeReview[], json: boolean): number {
  const message = `Notifai's hooks wait for the User's approval in ${pending.length === 1 ? 'one Codex home' : `${pending.length} Codex homes`}. ` +
    `The User approves them: ask them to run \`${CODEX_REVIEW_COMMAND}\` in a terminal on this machine. It opens Codex's own hook review in each home; never approve hooks for them.`
  if (json) {
    deps.io.out(JSON.stringify({
      ok: false,
      user_command: CODEX_REVIEW_COMMAND,
      message,
      homes: pending.map((review) => ({ home: review.home, state: review.state, handlers: review.findings })),
    }))
  } else {
    for (const review of pending) deps.io.out(pendingLine(review))
    deps.io.out(message)
  }
  return EXIT.failed
}

/** Whether a person, not an agent, drives this terminal. */
function userAtTerminal(deps: CommandDeps): boolean {
  if (deps.io.interactive !== true) return false
  const markers = inheritedHarnessMarkers(deps.env)
  return markers.active === null && markers.contested.length === 0
}

export async function doctorCodexCommand(
  deps: CommandDeps,
  opts: { json?: boolean } = {},
  seams: CodexReviewSeams = deps.codexReview ?? {},
): Promise<number> {
  const platform = deps.hookPlatform ?? process.platform
  const codexPath = seams.codexPath !== undefined ? seams.codexPath : findCodexExecutable(deps.env, platform)
  const homes = codexReviewHomes(deps.env, platform)
  // Orca copies ~/.codex's hooks and their approval into each account home when it starts Codex there.
  const orca = homes.filter((home) => home.host === 'orca')
  const assess = (home: CodexReviewHome) => assessCodexHome(home, deps, {
    ...(codexPath === null ? { list: null } : {}),
    ...(seams.installations === undefined ? {} : { installations: seams.installations }),
  })
  const reviews: CodexHomeReview[] = []
  for (const home of homes.filter((entry) => entry.host !== 'orca')) reviews.push(await assess(home))
  const installed = reviews.filter((review) => review.state !== 'not-installed')
  if (installed.length === 0) {
    const message = "Notifai's Codex hooks aren't installed in any Codex home here. Run `notifai hooks install --harness codex` first."
    deps.io.out(opts.json === true ? JSON.stringify({ ok: false, message, homes: [] }) : message)
    return EXIT.failed
  }
  const pending = installed.filter((review) => review.state !== 'approved')
  const orcaNote = orca.length === 0 ? null
    : `Orca's Codex accounts take their approval from ~/.codex: Orca copies it the next time it starts Codex there.`
  if (pending.length === 0) {
    const message = `Notifai's hooks are approved in every Codex home Notifai knows (${installed.map((review) => review.label).join(', ')}). Nothing to do.`
    if (opts.json === true) deps.io.out(JSON.stringify({ ok: true, message, homes: installed.map((review) => ({ home: review.home, state: review.state })) }))
    else { deps.io.out(message); if (orcaNote !== null) deps.io.out(orcaNote) }
    return EXIT.ok
  }
  if (opts.json === true || !userAtTerminal(deps)) return agentReport(deps, pending, opts.json === true)

  for (const review of installed.filter((entry) => entry.state === 'approved')) deps.io.out(`✓ ${review.label}: approved`)
  if (codexPath === null) {
    deps.io.out('The Codex CLI isn\'t installed, so Notifai can\'t open its hook review here.')
    for (const review of pending) {
      deps.io.out(`• ${pendingLine(review)}`)
      deps.io.out(review.isDefault
        ? '  In the ChatGPT app or your editor, click the Review hooks icon by the message box and allow them (Settings → Hooks for hooks that are off).'
        : `  Install the Codex CLI (npm install -g @openai/codex), then run ${CODEX_REVIEW_COMMAND} again.`)
    }
    return EXIT.failed
  }
  const launch = seams.launch ?? launchInForeground
  let remaining = 0
  for (const review of pending) {
    deps.io.out('')
    deps.io.out(`• ${pendingLine(review)}`)
    const plan = codexReviewLaunch(review, review.login, platform)
    deps.io.out(`  ${howToApprove(review)}`)
    if (!review.login) deps.io.out("  No sign-in needed: it starts Codex with model_provider=ollama, and Ollama needn't be installed.")
    const go = await deps.io.confirm('Open Codex now?', true)
    const outcome = go ? await launch(plan, codexPath) : 'skipped'
    const after = outcome === 'exited' ? await assess(review) : review
    if (after.state === 'approved') {
      deps.io.out(`✓ ${review.label}: approved`)
      continue
    }
    remaining += 1
    if (outcome === 'failed') deps.io.out(`  Codex didn't start. In a terminal, run: ${plan.display}`)
    else deps.io.out(`  Still waiting: ${pendingLine(after)}. Run ${CODEX_REVIEW_COMMAND} again when you're ready.`)
  }
  if (orcaNote !== null) deps.io.out(orcaNote)
  deps.io.out('')
  deps.io.out(remaining === 0
    ? "Done: Notifai's hooks are approved in every Codex home Notifai knows. New Codex sessions use them."
    : `${remaining} Codex ${remaining === 1 ? 'home still waits' : 'homes still wait'} for approval.`)
  return remaining === 0 ? EXIT.ok : EXIT.failed
}
