#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import {
  askCommand,
  accessStatusCommand,
  authStatusCommand,
  capabilitiesCommand,
  closeCommand,
  configExplainCommand,
  configSetCommand,
  configShowCommand,
  configUnsetCommand,
  devicesCommand,
  doctorCommand,
  hookDefersDiagnosticsUntilAfterCleanup,
  hookRunCommand,
  hooksInstallCommand,
  hooksUninstallCommand,
  initCommand,
  loginCommand,
  logoutCommand,
  logsCommand,
  realIo,
  repliesCommand,
  sendCommand,
  statusCommand,
  type CommandDeps,
} from './commands.js'
import { defaultCredentialStore } from './credentials.js'
import { HARNESSES } from './install-hooks.js'
import type { Platform } from '@raidiant/notifai-protocol'
import { nativeSkills, type SkillScope } from './native-skills.js'
import { GROUP, SEND_GROUP, helpConfiguration, rootHelpFooter } from './ui/help.js'

import { readStdinWithTimeout } from './hook-input.js'
import { bootstrapLogger } from './logging.js'

/**
 * The local record for this invocation.
 *
 * Built before the command tree so that the very first thing recorded is the
 * command starting — including for a command that goes on to fail before it has
 * resolved anything. It configures itself from disk and disables itself if it
 * cannot write, so nothing below has to handle it failing.
 */
const logger = bootstrapLogger()

const deps: CommandDeps = {
  io: realIo(),
  store: defaultCredentialStore(),
  env: process.env,
  cwd: process.cwd(),
  nativeSkills,
  logger,
}

/**
 * One source of truth for the version: the manifest npm actually published.
 *
 * It was hardcoded here as well, and the first patch release proved why that
 * does not hold — `package.json` moved and `notifai --version` kept reporting
 * the old number, which is exactly the string someone pastes into a bug report
 * to say what they are running.
 */
function version(): string {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { version?: unknown }).version === 'string') {
      return (parsed as { version: string }).version
    }
  } catch {
    // Fall through: an unreadable manifest must not stop the CLI running.
  }
  return 'unknown'
}

/**
 * The full command path, e.g. `config set`, so a filter on `cmd` distinguishes
 * subcommands that share a leaf name.
 */
function commandPath(command: Command): string {
  const parts: string[] = []
  for (let node: Command | null = command; node?.parent != null; node = node.parent) {
    parts.unshift(node.name())
  }
  return parts.join(' ') || 'notifai'
}

/**
 * Which flags were passed, without their values.
 *
 * The flag names answer nearly every question worth asking of an invocation —
 * was `--reply` set, was `--all` — while the values are notification content
 * and user text that has no business being recorded merely because a command
 * ran. Values are available under `log_level = debug`, which is a deliberate act.
 */
function flagNames(argv: readonly string[]): string[] {
  return argv.filter((token) => token.startsWith('--'))
}

const startedAt = Date.now()
process.on('exit', (code) => {
  logger.info('cli.end', {
    exit: code,
    duration_ms: Date.now() - startedAt,
    flags: flagNames(process.argv.slice(2)),
  })
})

const program = new Command('notifai')
  .description('Send native device notifications from agents and local programs')
  .version(version())
  .configureHelp(helpConfiguration)
  // Lazy on purpose. `addHelpText` also takes a string, but that builds the
  // footer on every invocation — including the hook that runs in front of
  // every prompt the user types, which never renders help at all.
  .addHelpText('after', () => rootHelpFooter())
  // Commander's default is to print the full help and exit 0 for an unknown
  // `help` topic, so `notifai help nonsense` looked like it had worked. A
  // reader who mistyped a command deserves to be told, and a script deserves
  // a nonzero code.
  .showSuggestionAfterError(true)
  // Commander drops the implicit `help [command]` as soon as the program
  // itself has an action handler — which the interactive default below gives
  // it. Without this, adding that default would silently break
  // `notifai help send` for everyone who reaches for it before `--help`.
  .helpCommand(true)
  // Where the implicit help command lands; every other command names its own.
  .commandsGroup(GROUP.help)
  .hook('preAction', (_program, actionCommand) => {
    logger.bind({ cmd: commandPath(actionCommand) })
    // SessionEnd uses the hook policy shared with commands.ts: local cleanup
    // precedes every diagnostic that can wait on the shared log lock.
    const deferDiagnostics =
      actionCommand.name() === 'hook' &&
      hookDefersDiagnosticsUntilAfterCleanup(actionCommand.processedArgs[0])
    // Values only at `debug`; `cli.end` carries the flag names at every level.
    if (!deferDiagnostics) {
      logger.debug('cli.start', {
        version: version(),
        argv: process.argv.slice(2),
        cwd: process.cwd(),
      })
    }
  })

/**
 * Bare `notifai`.
 *
 * At a human terminal this opens the interactive app; anywhere else it prints
 * help exactly as before. The check is the same one every other prompt in this
 * CLI is gated on — stdin and stdout both TTYs, not CI, `NOTIFAI_NO_INPUT`
 * unset — because an agent that reaches a prompt does not fail, it hangs
 * for ever waiting on a stdin nobody is typing into.
 *
 * The import is dynamic so that the prompt library, the banner and the whole
 * interactive tree cost nothing to the paths that never draw them — `send`,
 * `ask`, and the hook that runs in front of every prompt the user types.
 */
program.action(async () => {
  if (deps.io.interactive !== true) {
    program.outputHelp()
    return
  }
  const { interactiveCommand } = await import('./interactive.js')
  process.exit(await interactiveCommand(deps, version()))
})

// Setup leads: `init` is the single entry command for first-run friendliness.
program
  .command('init')
  .helpGroup(GROUP.start)
  .summary('Set this project up, step by step')
  .description(
    'Set up Notifai here, idempotently: sign-in, project id, hooks, device readiness, live receipt proof. ' +
      'Interactive at a human terminal; never prompts otherwise (agents: pass flags)',
  )
  .option('--project-id <id>', 'project identifier slug (default: derived from the directory name)')
  .option('--skills', 'install/update the agent skill from its pinned public release')
  .option('--no-skills', 'suppress the optional agent-skill status line')
  .option('--skills-scope <scope>', 'unattended skill scope: project or global')
  .option('--hooks', 'install harness hooks for registered-question routing')
  .option('--no-hooks', 'skip the hooks without being asked')
  .action(async (opts: { projectId?: string; skills?: boolean; skillsScope?: SkillScope; hooks?: boolean }) => {
    process.exit(await initCommand(deps, opts))
  })

program
  .command('doctor')
  .helpGroup(GROUP.daily)
  .summary('Check every part of the setup')
  .description('Audit config, credential, server, contract, device, hook, and saved receipt proof; exits nonzero when any line is FAIL (no live send)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    process.exit(await doctorCommand(deps, opts))
  })

program
  .command('login')
  .helpGroup(GROUP.start)
  .summary('Sign in and pair this machine')
  .description('Pair this machine with your Notifai account via browser approval')
  .option('--name <name>', 'machine name shown in the dashboard (default: hostname)')
  .option('--base-url <url>', 'Notifai server URL')
  .option('--no-open', 'do not open the approval page in a browser')
  .action(async (opts: { name?: string; baseUrl?: string; open?: boolean }) => {
    process.exit(await loginCommand(deps, opts))
  })

program
  .command('logout')
  .helpGroup(GROUP.advanced)
  .summary('Remove the stored machine credential')
  .description('Remove the stored machine credential')
  .action(() => {
    process.exit(logoutCommand(deps))
  })

const auth = program
  .command('auth')
  .description('Authentication helpers')
  .summary('Machine identity and account plan')
  .helpGroup(GROUP.advanced)
auth
  .command('status')
  .description('Show the stored machine identity')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => {
    process.exit(authStatusCommand(deps, opts))
  })
auth
  .command('access')
  .description('Show the account plan and access decision')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    process.exit(await accessStatusCommand(deps, opts))
  })

program
  .command('devices')
  .helpGroup(GROUP.daily)
  .summary('List your devices and whether they can receive')
  .description('List registered devices and their delivery readiness')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    process.exit(await devicesCommand(deps, opts))
  })

program
  .command('capabilities')
  .helpGroup(GROUP.advanced)
  .summary('Show what a platform can render')
  .description('Show a platform capability contract')
  .option('--platform <platform>', 'platform to describe (default: ios)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean; platform?: Platform }) => {
    process.exit(await capabilitiesCommand(deps, opts))
  })

const send = program
  .command('send')
  .helpGroup(GROUP.agent)
  .summary('Send a notification')
  .description('Send a notification')
  .optionsGroup(SEND_GROUP.content)
  .requiredOption('--title <title>', 'notification title')
  .requiredOption('--body <body>', 'notification body')
  .option('--subtitle <subtitle>', 'a line between the title and the body')
  .option('--detail <markdown>', 'long-form markdown shown only in the app, never on the banner')
  .option('--detail-file <path>', 'read --detail from a file (use - for stdin)')
  .option('--image <path|url|media_id>', 'upload or attach an image')
  .optionsGroup(SEND_GROUP.routing)
  .option('--kind <kind>', 'what this is: update (default) | done | question (requires --reply)')
  .option('--project <id>', 'project identifier, e.g. my-app (lazily registered)')
  .option('--device <id>', 'target a device id (repeatable)', (v: string, all: string[]) => [...all, v], [])
  .option('--all', 'target all routable devices (overrides configured devices)')
  .option('--session <id>', 'session identity (env: NOTIFAI_SESSION); presentation varies by surface')
  .option('--event <event>', 'agent event name, e.g. tests_passed')
  .optionsGroup(SEND_GROUP.presentation)
  .option('--sound <sound>', 'default | done | attention | alert | none')
  .option('--level <level>', 'interruption level: passive | active | time_sensitive')
  .option('--collapse-key <key>', 'replace earlier notifications with the same key')
  .option('--thread-id <id>', 'group related notifications')
  .option('--ttl <seconds>', 'delivery window in seconds', (v: string) => Number(v))
  .option('--platform <platform>', 'limit optional fields to ios or macos (default: both)')
  .optionsGroup(SEND_GROUP.reply)
  .option('--reply', 'enable the inline reply action and block for the answer')
  .option('--reply-timeout <seconds>', 'how long to wait for a reply (default: 900)', (v: string) => Number(v))
  .option('--reply-window <seconds>', 'how long the server accepts a reply (default: 3600)', (v: string) => Number(v))
  .option(
    '--reply-choice <label>',
    'with --reply, ask a closed question; repeat the flag once per answer (2-6)',
    (v: string, all: string[]) => [...all, v], [],
  )
  .option('--reply-multi', 'with --reply-choice, several answers may be selected')
  // Kept registered, and always a usage error with --reply, so the caller gets
  // a message pointing at `ask` instead of "unknown option".
  .option('--no-block', 'rejected with --reply; use `notifai ask` to ask and end the turn')
  .optionsGroup(SEND_GROUP.advanced)
  .option('--wait <seconds>', 'how long to wait for provider outcomes', (v: string) => Number(v))
  .option('--no-wait', 'return immediately after acceptance')
  .option('--data <key=value>', 'custom data (repeatable)', (v: string, all: string[]) => [...all, v], [])
  .option('--idempotency-key <key>', 'safe-retry key (default: random)')
  .option('--base-url <url>', 'Notifai server URL')
  .option('--json', 'print the full submission receipt as JSON')
  .action(async (opts: Record<string, unknown>) => {
    // commander maps --no-wait onto the same "wait" flag; disentangle.
    const noWait = opts['wait'] === false
    const wait = typeof opts['wait'] === 'number' ? opts['wait'] : undefined
    const noBlock = opts['block'] === false
    const sendOpts = { ...opts }
    // Same empty-collector normalisation as `ask`.
    if (Array.isArray(sendOpts['replyChoice']) && sendOpts['replyChoice'].length === 0) {
      delete sendOpts['replyChoice']
    }
    delete sendOpts['block']
    // Long-form detail is usually a build log or a diff summary, which nobody
    // wants to shell-escape onto a command line.
    const detailFile = sendOpts['detailFile']
    delete sendOpts['detailFile']
    if (typeof detailFile === 'string') {
      if (sendOpts['detail'] !== undefined) {
        deps.io.err('Pass either --detail or --detail-file, not both.')
        process.exit(2)
      }
      try {
        sendOpts['detail'] = readFileSync(detailFile === '-' ? 0 : detailFile, 'utf8')
      } catch (err) {
        deps.io.err(`Could not read ${detailFile}: ${String(err)}`)
        process.exit(2)
      }
    }
    const flags = { ...sendOpts, noWait, noBlock } as Parameters<typeof sendCommand>[1]
    if (wait === undefined) delete (flags as { wait?: number }).wait
    else flags.wait = wait
    process.exit(await sendCommand(deps, flags))
  })

send.addHelpText(
  'after',
  `\nKind profiles (used unless --sound, --level, or saved user config overrides them):\n  update    sound none       level passive\n  done      sound done       level passive\n  question  sound attention  level active (--reply)\n`,
)

program
  .command('replies [request_id]')
  .helpGroup(GROUP.agent)
  .summary('Retrieve replies to a question')
  .description('Retrieve replies for a notification request')
  .option('--pending', 'use the pushed question pending for this project session')
  .option('--wait <seconds>', 'how long to wait for a reply', (v: string) => Number(v))
  .option('--after <seq>', 'return replies after this sequence number', (v: string) => Number(v))
  .option('--json', 'machine-readable output')
  .action(async (requestId: string | undefined, opts: { wait?: number; after?: number; json?: boolean; pending?: boolean }) => {
    process.exit(await repliesCommand(deps, requestId, opts))
  })

program
  .command('status <request_id>')
  .helpGroup(GROUP.agent)
  .summary('Show the evidence trail for a request')
  .description('Show the evidence trail for a notification request')
  .option('--json', 'machine-readable output')
  .action(async (requestId: string, opts: { json?: boolean }) => {
    process.exit(await statusCommand(deps, requestId, opts))
  })

program
  .command('ask [question]')
  .helpGroup(GROUP.agent)
  .summary('Register a question, then end the turn')
  .description('Register a question for the turn-end hook to route under your presence settings')
  .option(
    '--choice <label>',
    'answers to offer instead of free text; repeat the flag once per answer (2-6)',
    (v: string, all: string[]) => [...all, v], [],
  )
  .option('--multi', 'with --choice, several answers may be selected')
  .option('--detail <markdown>', 'long-form context shown only in the app, never on the banner')
  .option('--detail-file <path>', 'read --detail from a file (use - for stdin)')
  .option('--form <path>', 'ask several questions as one form; JSON file (use - for stdin)')
  .option('--session <id>', 'session id (default: the session working in this directory, else $NOTIFAI_SESSION)')
  .action((question: string | undefined, opts: {
    choice?: string[]
    multi?: boolean
    detail?: string
    detailFile?: string
    form?: string
    session?: string
  }) => {
    let detail = opts.detail
    if (typeof opts.detailFile === 'string') {
      if (detail !== undefined) {
        deps.io.err('Pass either --detail or --detail-file, not both.')
        process.exit(2)
      }
      try {
        detail = readFileSync(opts.detailFile === '-' ? 0 : opts.detailFile, 'utf8')
      } catch (err) {
        deps.io.err(`Could not read ${opts.detailFile}: ${String(err)}`)
        process.exit(2)
      }
    }
    let form: string | undefined
    if (typeof opts.form === 'string') {
      try {
        form = readFileSync(opts.form === '-' ? 0 : opts.form, 'utf8')
      } catch (err) {
        deps.io.err(`Could not read ${opts.form}: ${String(err)}`)
        process.exit(2)
      }
    }
    // commander's collector defaults to []; an empty list means "not asked".
    const flags: Parameters<typeof askCommand>[2] = {
      ...(opts.session !== undefined ? { session: opts.session } : {}),
      ...(opts.choice?.length ? { choice: opts.choice } : {}),
      ...(opts.multi ? { multi: true } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(form !== undefined ? { form } : {}),
    }
    process.exit(askCommand(deps, question, flags))
  })

program
  .command('close <request_id>')
  .helpGroup(GROUP.agent)
  .summary('Retire a question so late answers are rejected')
  .description('Retire a question so late answers are rejected rather than lost')
  .action(async (requestId: string) => {
    process.exit(await closeCommand(deps, requestId))
  })

// Hidden, not removed. It is an entry point the hook installer writes into a
// harness config file, never something a person types — and listing it beside
// `send` invited exactly one reading, which is that you were supposed to.
program
  .command('hook <event>', { hidden: true })
  .description('Internal: run a harness hook (reads hook JSON on stdin)')
  // Inert, and the point of it is that it is inert: the installed command line
  // carries a marker that says "Notifai wrote this" independently of which
  // checkout wrote it.
  .option('--owner <name>', 'internal ownership marker')
  .option('--harness <name>', 'internal harness output adapter')
  .action(async (event: string, opts: { harness?: string }) => {
    const harness = HARNESSES.find((candidate) => candidate === opts.harness)
    process.exit(
      await hookRunCommand(deps, event, () => readStdinWithTimeout(), harness),
    )
  })

const hooks = program
  .command('hooks')
  .description('Install harness hooks for registered-question routing')
  .summary('Wire a harness to route questions to your devices')
  .helpGroup(GROUP.advanced)
hooks
  .command('install')
  .description('Wire this harness to route registered questions to your devices')
  .option(
    '--harness <name>',
    'claude-code | codex | cursor | opencode (default: detected; OpenCode delivers answers on the next prompt)',
  )
  .option('--global', 'install for every project instead of just this one')
  .action((opts: { harness?: string; global?: boolean }) => {
    process.exit(hooksInstallCommand(deps, opts))
  })
hooks
  .command('uninstall')
  .description('Remove the hooks this CLI installed')
  .option('--harness <name>', 'claude-code | codex | cursor | opencode (default: detected)')
  .option('--global', 'remove the machine-wide install')
  .action((opts: { harness?: string; global?: boolean }) => {
    process.exit(hooksUninstallCommand(deps, opts))
  })

program
  .command('logs')
  .helpGroup(GROUP.daily)
  .summary('Show what this machine recorded about what it did')
  .description(
    'Read the local record of commands, notifications, and the question decisions harness hooks made. ' +
      'Bounded and scoped to this project by default; never leaves this machine',
  )
  .option('-n, --limit <count>', 'how many records to show (default: 30)', (v: string) => Number(v))
  .option('--all', 'lift the default limit, up to a hard cap')
  .option('--since <when>', 'only records newer than this: 10m, 2h, 1d, or an ISO 8601 instant')
  .option('--level <level>', 'minimum severity: error | info | debug (error shows only failures)')
  .option('--event <name>', 'only this event; repeatable', (v: string, all: string[]) => [...all, v], [])
  .option('--run <id>', 'everything one command invocation did')
  .option('--request <id>', 'everything about one notification request')
  .option('--session <id>', 'only this harness session')
  .option('--project <id>', 'only this project')
  .option('--all-projects', 'do not scope to the project in this directory')
  .option('--grep <text>', 'only records containing this text')
  .option('--json', 'one JSON record per line on stdout')
  .option('--path', 'print the log file paths instead of the records')
  .option('--clear', 'delete the log files')
  .action((opts: Record<string, unknown>) => {
    const flags = { ...opts } as Parameters<typeof logsCommand>[1]
    if (Array.isArray(flags.event) && flags.event.length === 0) delete flags.event
    process.exit(logsCommand(deps, flags))
  })

const config = program
  .command('config')
  .description('Show or change settings')
  .summary('Show or change settings')
  .helpGroup(GROUP.daily)
config
  .command('show')
  .description('Show every setting, what it does, and where its value came from')
  .option('--explain', 'include advanced settings and the file each value came from')
  .option('--plain', 'the flat key = value form, even at a terminal')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean; explain?: boolean; plain?: boolean }) => {
    process.exit(configShowCommand(deps, opts))
  })
config
  .command('explain <key>')
  .description('Explain one setting in full: what it does, what it accepts, what it is now')
  .option('--json', 'machine-readable output')
  .action((key: string, opts: { json?: boolean }) => {
    process.exit(configExplainCommand(deps, key, opts))
  })
config
  .command('set <key> <value>')
  .description(
    'Set a configuration value (choose a layer interactively; unattended defaults machine-global and requires --yes)',
  )
  .option('--project', 'write to the shared .notifai/config.toml instead')
  .option('--local', 'write to personal .notifai/config.local.toml (keep it gitignored)')
  .option('--session <id>', 'apply only to one session')
  .option('--yes', 'skip the confirmation gate')
  .action(
    async (
      key: string,
      value: string,
      opts: { project?: boolean; local?: boolean; session?: string; yes?: boolean },
    ) => {
      process.exit(await configSetCommand(deps, key, value, opts))
    },
  )
config
  .command('unset <key>')
  .description(
    'Remove a configuration value so the next layer or shipped default applies (choose a layer interactively; unattended defaults machine-global and requires --yes)',
  )
  .option('--project', 'remove from the shared .notifai/config.toml instead')
  .option('--local', 'remove from personal .notifai/config.local.toml')
  .option('--session <id>', 'remove from one session')
  .option('--yes', 'skip the confirmation gate')
  .action(
    async (
      key: string,
      opts: { project?: boolean; local?: boolean; session?: string; yes?: boolean },
    ) => {
      process.exit(await configUnsetCommand(deps, key, opts))
    },
  )

await program.parseAsync(process.argv)
