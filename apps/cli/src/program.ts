import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import {
  acknowledgeCommand,
  askCommand,
  accessStatusCommand,
  agentSessionRenameCommand,
  authStatusCommand,
  capabilitiesCommand,
  closeCommand,
  cliUpdateCommand,
  configExplainCommand,
  configSetCommand,
  configShowCommand,
  configUnsetCommand,
  devicesCommand,
  doctorCommand,
  guidanceSetCommand,
  guidanceShowCommand,
  guidanceUnsetCommand,
  hookDefersDiagnosticsUntilAfterCleanup,
  hookRunCommand,
  hooksInstallCommand,
  hooksUninstallCommand,
  initCommand,
  loginCommand,
  logoutCommand,
  projectDisableCommand,
  projectEnableCommand,
  projectStatusCommand,
  logsCommand,
  repliesCommand,
  reportAskFailure,
  sendCommand,
  soundsCommand,
  statusCommand,
  type CommandDeps,
} from './commands.js'
import { packageVersion } from './release.js'
import { HOOK_INSTALLABLE_HARNESSES } from './harnesses.js'
import type { Platform } from '@raidiant/notifai-protocol'
import type { SkillScope } from './native-skills.js'
import { GROUP, SEND_GROUP, helpConfiguration, rootHelpFooter } from './ui/help.js'
import { readStdinWithTimeout } from './hook-input.js'
import { argvFlagNames } from './logging.js'
import { QUESTION_SETTLEMENT_INPUT_ENV } from './question-settlement-process.js'

/**
 * One source of truth for the version: the manifest npm actually published.
 *
 * It was hardcoded here as well, and the first patch release proved why that
 * does not hold — `package.json` moved and `notifai --version` kept reporting
 * the old number, which is exactly the string someone pastes into a bug report
 * to say what they are running.
 *
 * `unknown` is the display form of "this build cannot tell"; the skill pin
 * derived from the same source refuses instead, because a wrong ref installs
 * the wrong thing while a wrong version string only misinforms.
 */
function version(): string {
  return packageVersion() ?? 'unknown'
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
 * Every command implementation the tree dispatches to, injectable so a test
 * can parse real argv and assert the exact flags a command would receive —
 * the layer where `--no-wait` disentangling and collector defaults live, which
 * unit tests on the commands themselves can never see.
 */
const defaultRunners = {
  init: initCommand,
  doctor: doctorCommand,
  update: cliUpdateCommand,
  login: loginCommand,
  logout: logoutCommand,
  authStatus: authStatusCommand,
  accessStatus: accessStatusCommand,
  devices: devicesCommand,
  sounds: soundsCommand,
  capabilities: capabilitiesCommand,
  projectEnable: projectEnableCommand,
  projectDisable: projectDisableCommand,
  projectStatus: projectStatusCommand,
  agentSessionRename: agentSessionRenameCommand,
  send: sendCommand,
  replies: repliesCommand,
  acknowledge: acknowledgeCommand,
  status: statusCommand,
  ask: askCommand,
  close: closeCommand,
  hookRun: hookRunCommand,
  hooksInstall: hooksInstallCommand,
  hooksUninstall: hooksUninstallCommand,
  logs: logsCommand,
  configShow: configShowCommand,
  configExplain: configExplainCommand,
  configSet: configSetCommand,
  configUnset: configUnsetCommand,
  guidanceShow: guidanceShowCommand,
  guidanceSet: guidanceSetCommand,
  guidanceUnset: guidanceUnsetCommand,
  /**
   * Dynamic so that the prompt library, the banner and the whole interactive
   * tree cost nothing to the paths that never draw them — `send`, `ask`, and
   * the hook that runs in front of every prompt the user types.
   */
  interactive: async (deps: CommandDeps, versionString: string): Promise<number> => {
    const { interactiveCommand } = await import('./interactive.js')
    return interactiveCommand(deps, versionString)
  },
}

export type ProgramRunners = typeof defaultRunners

export interface BuildProgramOptions {
  /** Test seam; production ends the process with the command's exit code. */
  exit?: (code: number) => void
  runners?: Partial<ProgramRunners>
}

export function buildProgram(deps: CommandDeps, options: BuildProgramOptions = {}): Command {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const runners: ProgramRunners = { ...defaultRunners, ...options.runners }
  const logger = deps.logger

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
    .hook('preAction', (_program, actionCommand) => {
      logger?.bind({ cmd: commandPath(actionCommand) })
      // SessionEnd uses the hook policy shared with commands.ts: local cleanup
      // precedes every diagnostic that can wait on the shared log lock.
      const deferDiagnostics =
        actionCommand.name() === 'hook' &&
        hookDefersDiagnosticsUntilAfterCleanup(actionCommand.processedArgs[0])
      // Values only at `debug`; `cli.end` carries the flag names at every level.
      if (!deferDiagnostics) {
        logger?.debug('cli.start', {
          version: version(),
          flags: argvFlagNames(process.argv.slice(2)),
          cwd: process.cwd(),
        })
      }
    })

  /**
   * Commander exits 1 for every usage error it detects itself, which contradicts
   * the exit vocabulary this CLI documents and every hand-written usage error it
   * returns. A caller branching on exit codes should not have to know which layer
   * rejected it. Help and version stay successful.
   */
  program.exitOverride((err) => {
    exit(err.exitCode === 0 ? 0 : 2)
  })

  /**
   * Bare `notifai`.
   *
   * At a human terminal this opens the interactive app, which enters `init`
   * when the machine is not yet paired and otherwise offers daily actions.
   * Anywhere else it prints help exactly as before. The check is the same one
   * every other prompt in this CLI is gated on — stdin and stdout both TTYs,
   * not CI, `NOTIFAI_NO_INPUT` unset — because an agent that reaches a prompt
   * does not fail, it hangs for ever waiting on a stdin nobody is typing into.
   */
  /**
   * An unrecognised subcommand reaches the root as an excess argument, and
   * "expected 0 arguments but got 1" tells a caller nothing about what it typed
   * or what exists. Naming it — with the nearest real command when there is one —
   * turns a dead end into one more try.
   */
  program.usage('[options] [command]')
  program.argument('[command]').action(async (command?: string) => {
    if (command !== undefined) {
      const names = program.commands.map((cmd) => cmd.name())
      const near = names.filter(
        (name) =>
          name.startsWith(command.slice(0, 2)) ||
          command.startsWith(name.slice(0, 2)) ||
          name.includes(command) ||
          command.includes(name),
      )
      deps.io.err(
        `Unknown command "${command}".` +
          (near.length > 0 ? ` Did you mean: ${near.slice(0, 3).join(', ')}?` : '') +
          ' Run notifai --help for the full list.',
      )
      return exit(2)
    }
    if (deps.io.interactive !== true) {
      program.outputHelp()
      return
    }
    exit(await runners.interactive(deps, version()))
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
    .option('--project-id <id>', 'Project identifier slug (default: derived from the directory name)')
    .option('--json', 'machine-readable final readiness; never prompts')
    .option('--skills', 'install/update the agent skill from its pinned public release')
    .option('--no-skills', 'suppress the optional agent-skill status line')
    .option(
      '--setup-scope <scope>',
      'unattended setup scope: project or global (skill, hooks, and config). The CLI binary is always a global install',
    )
    .option('--skills-scope <scope>', 'unattended skill scope; same values as --setup-scope')
    .option('--hooks', 'install harness hooks for registered-question routing')
    .option('--no-hooks', 'skip the hooks without being asked')
    .action(
      async (opts: {
        projectId?: string
        json?: boolean
        skills?: boolean
        setupScope?: SkillScope
        skillsScope?: SkillScope
        hooks?: boolean
      }) => {
        exit(await runners.init(deps, opts))
      },
    )

  program
    .command('doctor')
    .helpGroup(GROUP.daily)
    .summary('Check every part of the setup')
    .description('Audit config, credential, server, contract, device, hook, and saved receipt proof; exits nonzero when any line is FAIL (no live send)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      exit(await runners.doctor(deps, opts))
    })

  program
    .command('update')
    .helpGroup(GROUP.start)
    .summary('Update the Notifai command this shell uses')
    .description('Update the effective global Notifai installation and keep Question Routing on it')
    .option('--json', 'machine-readable installation and adapter result')
    .action((opts: { json?: boolean }) => {
      exit(runners.update(deps, opts))
    })

  const project = program
    .command('project')
    .helpGroup(GROUP.daily)
    .summary('Control Notifai for this Project')
    .description('Inspect or change this Project\'s User-owned lifecycle enablement')
  project.command('enable').description('Enable lifecycle guidance for this Project').action(() => {
    exit(runners.projectEnable(deps))
  })
  project.command('disable').description('Disable lifecycle guidance for this Project').action(() => {
    exit(runners.projectDisable(deps))
  })
  project.command('status').description('Show lifecycle enablement for this Project').option('--json').action((opts: { json?: boolean }) => {
    exit(runners.projectStatus(deps, opts.json === true))
  })

  const session = program
    .command('session')
    .helpGroup(GROUP.agent)
    .summary('Inspect or rename the current Agent Session')
    .description('Operate on the exact Agent Session owned by the active harness')
  session
    .command('rename <label>')
    .description(
      'Rename this exact Agent Session; agents use this only after its job changes completely enough that the old label would mislead',
    )
    .option('--json', 'machine-readable output')
    .action(async (label: string, opts: { json?: boolean }) => {
      exit(await runners.agentSessionRename(deps, label, opts))
    })

  program
    .command('login')
    .helpGroup(GROUP.advanced)
    .summary('Sign in and pair this machine')
    .description('Pair this machine with your Notifai account via browser approval')
    .option('--name <name>', 'machine name shown in the dashboard (default: hostname)')
    .option('--base-url <url>', 'pairing override for the service origin (also NOTIFAI_BASE_URL)')
    .option('--no-open', 'do not open the approval page in a browser')
    .action(async (opts: { name?: string; baseUrl?: string; open?: boolean }) => {
      exit(await runners.login(deps, opts))
    })

  program
    .command('logout')
    .helpGroup(GROUP.advanced)
    .summary('Remove the stored machine credential')
    .description('Remove the stored machine credential')
    .action(() => {
      exit(runners.logout(deps))
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
      exit(runners.authStatus(deps, opts))
    })
  auth
    .command('access')
    .description('Show the account plan and access decision')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      exit(await runners.accessStatus(deps, opts))
    })

  program
    .command('devices')
    .helpGroup(GROUP.daily)
    .summary('List your devices and whether they can receive')
    .description('List registered devices and their delivery readiness')
    .option('--platform <platform>', 'show only devices on one supported platform')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean; platform?: string }) => {
      exit(await runners.devices(deps, opts))
    })

  program
    .command('sounds')
    .helpGroup(GROUP.daily)
    .summary('List shipped and Account custom sounds')
    .description(
      'List the sounds --sound and the saved sound key accept: shipped names and this Account\'s custom sounds',
    )
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      exit(await runners.sounds(deps, opts))
    })

  program
    .command('capabilities')
    .helpGroup(GROUP.advanced)
    .summary('Show what a platform can render')
    .description('Show a platform capability contract')
    .option('--platform <platform>', 'platform to describe (default: ios)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean; platform?: Platform }) => {
      exit(await runners.capabilities(deps, opts))
    })

  const send = program
    .command('send')
    .helpGroup(GROUP.agent)
    .summary('Send a notification')
    .description('Send a notification')
    .optionsGroup(SEND_GROUP.content)
    .requiredOption('--title <title>', 'brief title whose substance is immediately understandable')
    .option('--body <markdown>', 'canonical Markdown body')
    .option('--body-file <path>', 'read the canonical Markdown body from a file (use - for stdin)')
    .option(
      '--literal-backslash-n',
      'allow the two-character sequence \\n in --body instead of treating it as a mistaken escaped newline',
    )
    .option('--subtitle <subtitle>', 'a plain-text line between the title and body')
    .option(
      '--image <path|url|media_id>',
      'upload or attach an image in collection order (repeatable, maximum 8)',
      (v: string, all: string[] = []) => [...all, v],
    )
    .option(
      '--image-alt <text>',
      'alt text paired with --image occurrences by position (repeatable)',
      (v: string, all: string[] = []) => [...all, v],
    )
    .optionsGroup(SEND_GROUP.routing)
    .option('--kind <kind>', 'what this is (required): update | done | failed | blocked (no User reply would resume it) — question is set by --reply')
    .option('--project <id>', 'Project identifier override (otherwise configured or inferred)')
    .option('--projectless', 'deliberately omit Project identity for this notification')
    .option('--device <id>', 'target a device id (repeatable)', (v: string, all: string[] = []) => [...all, v])
    .option('--all', 'target all routable devices (overrides configured devices)')
    .option('--session-id <id>', 'low-level automation override for an opaque exact Agent Session (env: NOTIFAI_SESSION_ID)')
    .option(
      '--session-label <text>',
      'human Agent Session name; safe to repeat, with the first accepted name frozen (env: NOTIFAI_SESSION_LABEL)',
    )
    .optionsGroup(SEND_GROUP.presentation)
    .option('--collapse-key <key>', 'replace earlier notifications with the same key')
    .option('--thread-id <id>', 'group related notifications')
    .option('--ttl <seconds>', 'delivery window in seconds', (v: string) => Number(v))
    .option('--platform <platform>', 'limit optional fields to one supported platform')
    .optionsGroup(SEND_GROUP.reply)
    .option('--reply', 'enable the inline reply action and block for the answer')
    .option('--reply-timeout <seconds>', 'how long to wait for a reply (default: 900)', (v: string) => Number(v))
    .option(
      '--reply-window <seconds>',
      'how long an answer is still accepted, 60-259200 (default: reply_window_seconds, a day)',
      (v: string) => Number(v),
    )
    .option(
      '--choice <label>',
      'with --reply, ask a closed question; repeat the flag once per answer (2-6)',
      (v: string, all: string[] = []) => [...all, v],
    )
    .option('--multi', 'with --choice, several answers may be selected')
    .optionsGroup(SEND_GROUP.advanced)
    .option(
      '--sound <sound>',
      'override saved sound: default | done | attention | alert | none, or a custom name or id from notifai sounds',
    )
    .option(
      '--level <level>',
      'Apple-only interruption level: passive | active | time_sensitive (unsupported with --platform android)',
    )
    .option('--wait <seconds>', 'how long to wait for provider outcomes', (v: string) => Number(v))
    .option('--no-wait', 'return immediately after acceptance')
    .option('--data <key=value>', 'custom data (repeatable)', (v: string, all: string[] = []) => [...all, v])
    .option('--idempotency-key <key>', 'safe-retry key (default: random)')
    .option('--retry', 'explicitly retry one unresolved exact semantic send using its opaque saved attempt')
    .option(
      '--base-url <url>',
      'pairing override for the service origin; ignored when this machine is already paired (also NOTIFAI_BASE_URL)',
    )
    .option('--json', 'print the full submission receipt as JSON')
    .action(async (opts: Record<string, unknown>) => {
      // commander maps --no-wait onto the same "wait" flag; disentangle.
      const noWait = opts['wait'] === false
      const wait = typeof opts['wait'] === 'number' ? opts['wait'] : undefined
      const sendOpts = { ...opts }
      // Commander collectors default to []; an empty list means "not passed".
      for (const key of ['choice', 'image', 'imageAlt']) {
        if (Array.isArray(sendOpts[key]) && sendOpts[key].length === 0) delete sendOpts[key]
      }
      const bodyFile = sendOpts['bodyFile']
      delete sendOpts['bodyFile']
      if (typeof bodyFile === 'string') {
        if (sendOpts['body'] !== undefined) {
          deps.io.err('Pass either --body or --body-file, not both.')
          return exit(2)
        }
        try {
          sendOpts['body'] = readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8')
        } catch (err) {
          deps.io.err(`Could not read ${bodyFile}: ${String(err)}`)
          return exit(2)
        }
      }
      const flags = { ...sendOpts, noWait } as Parameters<typeof sendCommand>[1]
      if (wait === undefined) delete (flags as { wait?: number }).wait
      else flags.wait = wait
      exit(await runners.send(deps, flags))
    })

  send.addHelpText(
    'after',
    `\nKind is required, and it selects the sound the notification arrives with: done rings the completion chime, failed the most insistent tone, blocked and question a distinct attention tone, update Device default.\nAn explicit --sound or saved sound preference outranks that default. --sound accepts a shipped name, an Account custom sound name or id from \`notifai sounds\`, or none. --level is Apple-only; Android attention is owned by kind, product channels, and device settings.\n`,
  )

  program
    .command('replies [request_id]')
    .helpGroup(GROUP.agent)
    .summary('Retrieve replies to a question')
    .description('Retrieve replies for a notification request')
    .option('--pending', 'use the pushed question pending for this Project and Agent Session')
    .option('--wait <seconds>', 'how long to wait for a reply', (v: string) => Number(v))
    .option('--after <seq>', 'return replies after this sequence number', (v: string) => Number(v))
    .option('--json', 'machine-readable output')
    .action(async (requestId: string | undefined, opts: { wait?: number; after?: number; json?: boolean; pending?: boolean }) => {
      exit(await runners.replies(deps, requestId, opts))
    })

  program
    .command('acknowledge <request_id>')
    .helpGroup(GROUP.agent)
    .summary("Tell the user what you'll do because of their reply")
    .description(
      'Record the required Agent Acknowledgement for a replied-to notification request; never prompts',
    )
    .option('--text <text>', 'concrete work you will do because of the reply')
    .option('--json', 'machine-readable output')
    .action(async (requestId: string, opts: { text?: string; json?: boolean }) => {
      exit(await runners.acknowledge(deps, requestId, opts))
    })

  program
    .command('status <question_or_request_id>')
    .helpGroup(GROUP.agent)
    .summary('Show question state or request evidence')
    .description('Show local question state and, once submitted, the notification request evidence trail')
    .option('--json', 'machine-readable output')
    .action(async (requestId: string, opts: { json?: boolean }) => {
      exit(await runners.status(deps, requestId, opts))
    })

  program
    .command('ask [question]')
    .helpGroup(GROUP.agent)
    .summary('Register a question, then end the turn')
    .description('Register a question for the turn-end hook to route to your devices, subject to your question-routing settings')
    .option(
      '--choice <label>',
      'answers to offer instead of free text; repeat the flag once per answer (2-6)',
      (v: string, all: string[] = []) => [...all, v],
    )
    .option('--multi', 'with --choice, several answers may be selected')
    .option('--json', 'machine-readable output')
    .option('--body <markdown>', 'optional Markdown context appended after the question block')
    .option('--body-file <path>', 'read optional Markdown context from a file (use - for stdin)')
    .option(
      '--literal-backslash-n',
      'allow the two-character sequence \\n in --body instead of treating it as a mistaken escaped newline',
    )
    .option('--form <path>', 'ask several questions as one form; JSON file (use - for stdin)')
    .option(
      '--image <path|url|media_id>',
      'upload or attach an image in collection order (repeatable, maximum 8)',
      (v: string, all: string[] = []) => [...all, v],
    )
    .option(
      '--image-alt <text>',
      'alt text paired with --image occurrences by position (repeatable)',
      (v: string, all: string[] = []) => [...all, v],
    )
    .option('--project <id>', 'Project identifier override (otherwise configured or inferred)')
    .option(
      '--session-label <text>',
      'human Agent Session name; safe to repeat, with the first accepted name frozen (env: NOTIFAI_SESSION_LABEL)',
    )
    .action(async (question: string | undefined, opts: {
      choice?: string[]
      multi?: boolean
      json?: boolean
      body?: string
      bodyFile?: string
      literalBackslashN?: boolean
      form?: string
      image?: string[]
      imageAlt?: string[]
      project?: string
      sessionLabel?: string
    }) => {
      let body = opts.body
      if (typeof opts.bodyFile === 'string') {
        if (body !== undefined) {
          return exit(reportAskFailure(deps, opts, {
            code: 'invalid_input', check_id: 'body', exit_code: 2,
            remedy: 'pass either --body or --body-file, then retry',
            message: 'Pass either --body or --body-file, not both.',
          }))
        }
        try {
          body = readFileSync(opts.bodyFile === '-' ? 0 : opts.bodyFile, 'utf8')
        } catch (err) {
          return exit(reportAskFailure(deps, opts, {
            code: 'input_unreadable', check_id: 'body_file', exit_code: 2,
            remedy: 'fix the body-file path or permissions, then retry',
            message: `Could not read ${opts.bodyFile}: ${String(err)}`,
          }))
        }
      }
      let form: string | undefined
      if (typeof opts.form === 'string') {
        try {
          form = readFileSync(opts.form === '-' ? 0 : opts.form, 'utf8')
        } catch (err) {
          return exit(reportAskFailure(deps, opts, {
            code: 'input_unreadable', check_id: 'form_file', exit_code: 2,
            remedy: 'fix the form-file path or permissions, then retry',
            message: `Could not read ${opts.form}: ${String(err)}`,
          }))
        }
      }
      // Commander collectors default to []; an empty list means "not passed".
      const flags: Parameters<typeof askCommand>[2] = {
        ...(opts.choice?.length ? { choice: opts.choice } : {}),
        ...(opts.multi ? { multi: true } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(form !== undefined ? { form } : {}),
        ...(opts.image?.length ? { image: opts.image } : {}),
        ...(opts.imageAlt?.length ? { imageAlt: opts.imageAlt } : {}),
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        ...(opts.sessionLabel !== undefined ? { sessionLabel: opts.sessionLabel } : {}),
        ...(opts.json === true ? { json: true } : {}),
        ...(opts.literalBackslashN === true ? { literalBackslashN: true } : {}),
      }
      exit(await runners.ask(deps, question, flags))
    })

  program
    .command('close [question_or_request_id]')
    .helpGroup(GROUP.agent)
    .summary('Retire a question so late answers are rejected')
    .description(
      'Retire a question so late answers are rejected rather than lost. Pass --pending to withdraw this Agent Session\'s outstanding registrations, including ones the turn-end hook has not pushed yet.',
    )
    .option('--pending', 'retire this Agent Session\'s outstanding questions, including ones not yet pushed')
    .option('--json', 'machine-readable output')
    .action(async (requestId: string | undefined, opts: { json?: boolean; pending?: boolean }) => {
      exit(await runners.close(deps, requestId, opts))
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
      const harness = HOOK_INSTALLABLE_HARNESSES.find((candidate) => candidate === opts.harness)
      const settlementInput = deps.env[QUESTION_SETTLEMENT_INPUT_ENV]
      if (event === 'question-settlement') {
        delete deps.env[QUESTION_SETTLEMENT_INPUT_ENV]
      }
      exit(await runners.hookRun(
        deps,
        event,
        event === 'question-settlement' && settlementInput !== undefined
          ? async () => settlementInput
          : () => readStdinWithTimeout(),
        harness,
      ))
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
      'claude-code | codex | cursor | opencode | openclaw (default: every detected harness)',
    )
    .option('--global', 'install for every project instead of just this one')
    .action((opts: { harness?: string; global?: boolean }) => {
      exit(runners.hooksInstall(deps, opts))
    })
  hooks
    .command('uninstall')
    .description('Remove the hooks this CLI installed')
    .option('--harness <name>', 'claude-code | codex | cursor | opencode | openclaw (default: detected)')
    .option('--global', 'remove the machine-wide install')
    .action((opts: { harness?: string; global?: boolean }) => {
      exit(runners.hooksUninstall(deps, opts))
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
    .option('--event <name>', 'only this event; repeatable', (v: string, all: string[] = []) => [...all, v])
    .option('--run <id>', 'everything one command invocation did')
    .option('--request <id>', 'everything about one notification request')
    .option('--session <id>', 'only this Agent Session')
    .option('--project <id>', 'only this Project')
    .option('--all-projects', 'do not scope to the Project in this directory')
    .option('--grep <text>', 'only records containing this text')
    .option('--json', 'one JSON record per line on stdout')
    .option('--path', 'print the log file paths instead of the records')
    .option('--clear', 'delete the log files')
    .action((opts: Record<string, unknown>) => {
      const flags = { ...opts } as Parameters<typeof logsCommand>[1]
      if (Array.isArray(flags.event) && flags.event.length === 0) delete flags.event
      exit(runners.logs(deps, flags))
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
      exit(runners.configShow(deps, opts))
    })
  config
    .command('explain <key>')
    .description('Explain one setting in full: what it does, what it accepts, what it is now')
    .option('--json', 'machine-readable output')
    .action((key: string, opts: { json?: boolean }) => {
      exit(runners.configExplain(deps, key, opts))
    })
  config
    .command('set <key> <value>')
    .description(
      'Set a configuration value (choose a layer interactively; unattended defaults machine-global and requires --yes)',
    )
    .option('--project', 'write to the shared .notifai/config.toml instead')
    .option('--local', 'write a personal project preference on this machine (not in the repo)')
    .option('--session <id>', 'apply only to one Agent Session')
    .option('--yes', 'skip the confirmation gate')
    .action(
      async (
        key: string,
        value: string,
        opts: { project?: boolean; local?: boolean; session?: string; yes?: boolean },
      ) => {
        exit(await runners.configSet(deps, key, value, opts))
      },
    )
  config
    .command('unset <key>')
    .description(
      'Remove a configuration value so the next layer or shipped default applies (choose a layer interactively; unattended defaults machine-global and requires --yes)',
    )
    .option('--project', 'remove from the shared .notifai/config.toml instead')
    .option('--local', 'remove a personal project preference stored on this machine')
    .option('--session <id>', 'remove from one Agent Session')
    .option('--yes', 'skip the confirmation gate')
    .action(
      async (
        key: string,
        opts: { project?: boolean; local?: boolean; session?: string; yes?: boolean },
      ) => {
        exit(await runners.configUnset(deps, key, opts))
      },
    )

  const guidance = program
    .command('guidance')
    .description('How notifications are written: the shipped guidance and your overrides, per topic')
    .summary('Show or change how notifications are written')
    .helpGroup(GROUP.daily)
  guidance
    .command('show', { isDefault: true })
    .description('Print the effective guidance, every topic under the layer that supplied it')
    .option('--json', 'machine-readable output')
    .action((opts: { json?: boolean }) => {
      exit(runners.guidanceShow(deps, opts))
    })
  guidance
    .command('set <topic> [text]')
    .description(
      'Write one guidance topic in your words; it replaces the shipped topic of the same name for that scope ' +
        '(choose a layer interactively; unattended defaults machine-global and requires --yes)',
    )
    .option('--file <path>', 'read the guidance text from a file (use - for stdin)')
    .option('--project', 'write to the shared .notifai/guidance/ instead')
    .option('--local', 'write a personal project preference on this machine (not in the repo)')
    .option('--yes', 'skip the confirmation gate')
    .action(
      async (
        topic: string,
        text: string | undefined,
        opts: { file?: string; project?: boolean; local?: boolean; yes?: boolean },
      ) => {
        let content = text
        if (typeof opts.file === 'string') {
          if (content !== undefined) {
            deps.io.err('Pass either the text or --file, not both.')
            exit(2)
            return
          }
          try {
            content = readFileSync(opts.file === '-' ? 0 : opts.file, 'utf8')
          } catch (err) {
            deps.io.err(`Could not read ${opts.file}: ${String(err)}`)
            exit(2)
            return
          }
        }
        if (content === undefined) {
          deps.io.err('Pass the guidance text, or --file <path|-> to read it.')
          exit(2)
          return
        }
        exit(
          await runners.guidanceSet(deps, topic, content, {
            project: opts.project,
            local: opts.local,
            yes: opts.yes,
          }),
        )
      },
    )
  guidance
    .command('unset <topic>')
    .description(
      'Remove a guidance override so the next layer or the shipped topic applies ' +
        '(choose a layer interactively; unattended defaults machine-global and requires --yes)',
    )
    .option('--project', 'remove from the shared .notifai/guidance/ instead')
    .option('--local', 'remove a personal project preference stored on this machine')
    .option('--yes', 'skip the confirmation gate')
    .action(
      async (topic: string, opts: { project?: boolean; local?: boolean; yes?: boolean }) => {
        exit(await runners.guidanceUnset(deps, topic, opts))
      },
    )

  return program
}
