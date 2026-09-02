/**
 * The interactive app — what `notifai` does when a person runs it.
 *
 * Everything here is a shell around commands that already exist. `init`,
 * `login`, `doctor`, `send`, `hooks install` and `config set` keep their
 * behaviour, their validation and their exit codes; this module decides what to
 * offer, in what order, and how to say it. That is deliberate: a second
 * implementation of "set a config value" would be a second set of bugs, and the
 * menu would slowly stop agreeing with the flags.
 *
 * The module is imported dynamically, only after the caller is known to be a
 * human at a terminal. Nothing an agent runs — `send`, `ask`, and above all the
 * hook that runs in front of every prompt the user types — may pay to load a
 * prompt library it will never draw.
 *
 * Three things shape the layout:
 *
 * First-run is `init`, not a second sign-in/device split. An unsigned machine
 * enters that journey immediately; a remaining blocker is offered as Finish
 * setup. Once send-prerequisites are ready, the menu leads with the test
 * notification, because seeing the thing arrive on a device is what makes the
 * product real.
 *
 * Detail is earned, not given. A settings group shows fourteen one-line
 * summaries, and the paragraph explaining a key appears once the reader has
 * picked that key.
 *
 * Cancelling always goes back one level and never leaves the terminal in a
 * strange state.
 */
import * as clack from '@clack/prompts'
import {
  EXIT,
  assessReadiness,
  canDeviceReceive,
  configSetCommand,
  deviceInventory,
  doctorCommand,
  hooksInstallCommand,
  hooksUninstallCommand,
  initCommand,
  loginCommand,
  logoutCommand,
  sendCommand,
  type CommandDeps,
} from './commands.js'
import { loadConfig, type CliConfig, type ConfigKey } from './config.js'
import {
  detectedHarnesses,
  findInstallations,
} from './install-hooks.js'
import {
  CONFIG_GROUPS,
  acceptedValues,
  boundsHint,
  configInfo,
  configKeysByGroup,
  describeSource,
  formatValue,
  type ConfigGroup,
} from './config-schema.js'
import {
  firstBlocker,
  refreshAfterMenuAction,
  type Readiness,
  type ReadinessRefresh,
  type ReadinessState,
} from './readiness.js'
import { printBanner, tagline } from './ui/banner.js'
import { card, glyph, mark, style, type Tone } from './ui/theme.js'

/** Clack returns a symbol when the user pressed Ctrl-C or Escape. */
function cancelled(value: unknown): value is symbol {
  return clack.isCancel(value)
}

export type RoutingAction = 'install' | 'uninstall' | 'settings' | 'back'

export interface MenuOption<Value extends string> {
  value: Value
  label: string
  hint?: string
}

/**
 * Which hook actions this directory and setup can actually perform.
 *
 * Install is offered only when a harness is detectable here. Uninstall is
 * offered only when Notifai is actually wired, and it names what it removes:
 * there is one installation per harness, for this machine.
 */
export function routingHookActions(input: {
  canInstall: boolean
  installations: readonly { harness: string }[]
  hooksReady: boolean
}): MenuOption<RoutingAction>[] {
  const options: MenuOption<RoutingAction>[] = []
  const wired = input.installations.length > 0

  if (input.canInstall) {
    options.push({
      value: 'install',
      label: input.hooksReady || wired ? 'Re-install hooks' : 'Install hooks',
      hint: 'this machine; enable or disable Notifai per project separately',
    })
  }

  if (wired) {
    options.push({
      value: 'uninstall',
      label: 'Uninstall hooks on this machine',
      hint: harnessHint(input.installations),
    })
  }

  options.push(
    { value: 'settings', label: 'Change question settings', hint: 'when a question may leave this terminal' },
    { value: 'back', label: '← Back' },
  )
  return options
}

function harnessHint(installations: readonly { harness: string }[]): string {
  return [...new Set(installations.map((installation) => installation.harness))].join(', ')
}

type Screen =
  | 'test'
  | 'devices'
  | 'settings'
  | 'routing'
  | 'doctor'
  | 'account'
  | 'setup'
  | 'quit'

export async function interactiveCommand(deps: CommandDeps, version: string): Promise<number> {
  await printBanner()
  process.stdout.write(`  ${tagline(version)}\n`)

  let readiness = await assess(deps)
  if (stateById(readiness, 'credential')?.status !== 'ready') {
    await initCommand(deps, {})
    readiness = await assess(deps)
  }
  let first = true

  for (;;) {
    renderStatus(readiness, { compact: !first })
    first = false

    const choice = await clack.select<Screen>({
      message: 'What would you like to do?',
      options: menuFor(readiness),
    })
    // Root is the only place Escape/Ctrl-C quits. Every nested prompt returns.
    if (cancelled(choice)) return farewell()

    switch (choice) {
      case 'quit':
        return farewell()
      case 'setup':
        await initCommand(deps, {})
        readiness = await refresh(deps, readiness, refreshAfterMenuAction('setup', true))
        break
      case 'account': {
        const changed = await accountScreen(deps, readiness)
        readiness = await refresh(deps, readiness, refreshAfterMenuAction('account', changed))
        break
      }
      case 'test':
        await testNotificationScreen(deps)
        break
      case 'devices':
        await devicesScreen(deps)
        break
      case 'settings': {
        const result = await settingsScreen(deps)
        readiness = await refresh(
          deps,
          readiness,
          refreshAfterMenuAction('settings', result !== 'unchanged', { remote: result === 'remote' }),
        )
        break
      }
      case 'routing': {
        const changed = await routingScreen(deps, readiness)
        readiness = await refresh(deps, readiness, refreshAfterMenuAction('routing', changed))
        break
      }
      case 'doctor':
        // One assessment serves the report and the redraw. Doctor does not
        // change setup, so running the graph again would only wait.
        readiness = await assess(deps)
        await doctorCommand(deps, {}, { readiness })
        break
    }
  }
}

function farewell(): number {
  clack.outro(style.dim(`${glyph.bullet} bye`))
  return EXIT.ok
}

async function assess(
  deps: CommandDeps,
  options: { previous?: Readiness; refresh?: readonly ReadinessRefresh[] } = {},
): Promise<Readiness> {
  const spinner = clack.spinner()
  spinner.start('Checking your setup')
  try {
    return await assessReadiness(deps, options)
  } finally {
    spinner.stop(style.dim('Setup checked'))
  }
}

async function refresh(
  deps: CommandDeps,
  previous: Readiness,
  next: readonly ReadinessRefresh[] | null,
): Promise<Readiness> {
  return next === null ? previous : assess(deps, { previous, refresh: next })
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function stateById(readiness: Readiness, id: string): ReadinessState | undefined {
  return readiness.states.find((state) => state.id === id)
}

function toneOf(state: ReadinessState | undefined): Tone {
  if (state === undefined) return 'pending'
  switch (state.status) {
    case 'ready':
      return 'ok'
    case 'gap':
      return 'bad'
    case 'optional-gap':
      return 'warn'
    case 'unknown':
      return 'pending'
  }
}

/**
 * The status card: four lines that answer "is this working", with the detail
 * behind `doctor` rather than in front of everyone.
 *
 * `doctor` reports fourteen states because that is what a report is for. Home
 * shows the four that change what you would do next, which is why this reads
 * the same readiness model rather than a second one that could disagree.
 */
function renderStatus(readiness: Readiness, options: { compact?: boolean }): void {
  const rows: { label: string; state: ReadinessState | undefined; summary: (s?: ReadinessState) => string }[] = [
    {
      label: 'Account',
      state: stateById(readiness, 'credential'),
      summary: (s) => (s?.status === 'ready' ? accountSummary(readiness) : 'not signed in'),
    },
    {
      label: 'Devices',
      state: stateById(readiness, 'devices'),
      summary: (s) => shorten(s?.detail ?? 'unknown'),
    },
    {
      label: 'Project',
      state: stateById(readiness, 'project'),
      summary: (s) => (s?.status === 'ready' ? firstQuoted(s.detail) : 'not named'),
    },
    {
      label: 'Questions',
      state: stateById(readiness, 'hooks'),
      summary: (s) => (s?.status === 'ready' ? 'routing to your devices' : shorten(s?.detail ?? 'not wired')),
    },
  ]

  if (options.compact === true) {
    const summary = rows.map((row) => `${mark(toneOf(row.state))} ${style.dim(row.label)}`).join('   ')
    process.stdout.write(`\n  ${summary}\n\n`)
    return
  }

  const labelWidth = Math.max(...rows.map((row) => row.label.length))
  const body = rows.map(
    (row) => `${mark(toneOf(row.state))}  ${style.dim(row.label.padEnd(labelWidth))}  ${row.summary(row.state)}`,
  )
  process.stdout.write('\n')
  for (const line of card('Status', body)) process.stdout.write(`${line}\n`)
  process.stdout.write('\n')
}

function accountSummary(readiness: Readiness): string {
  const auth = stateById(readiness, 'auth')
  const email = auth?.detail.match(/\(([^)]+@[^)]+)\)/)?.[1]
  return email ?? 'signed in'
}

function firstQuoted(text: string): string {
  return text.match(/"([^"]+)"/)?.[1] ?? text
}

function shorten(text: string, limit = 46): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const clipped = flat.split(' — ')[0] ?? flat
  return clipped.length > limit ? `${clipped.slice(0, limit - 1)}…` : clipped
}

/**
 * The menu, ordered by what is actually in the way.
 *
 * A fixed menu would put "Send a test notification" first for someone who has
 * not signed in — an action that cannot succeed, offered ahead of the one that
 * would unblock it.
 */
function menuFor(readiness: Readiness): { value: Screen; label: string; hint?: string }[] {
  const signedIn = stateById(readiness, 'credential')?.status === 'ready'
  const devices = stateById(readiness, 'devices')
  const hasDevice = devices?.status === 'ready'
  const routing = stateById(readiness, 'hooks')
  const blocker = firstBlocker(readiness)

  const options: { value: Screen; label: string; hint?: string }[] = []

  if (blocker !== null) {
    options.push({
      value: 'setup',
      label: 'Finish setup',
      hint: shorten(blocker.title.toLowerCase(), 40),
    })
  } else if (signedIn && hasDevice) {
    options.push({
      value: 'test',
      label: 'Send a test notification',
      hint: 'prove the whole path, end to end',
    })
  }

  options.push(
    { value: 'settings', label: 'Settings', hint: 'sounds, timing, presence, project' },
    {
      value: 'routing',
      label: 'Question routing',
      hint: routing?.status === 'ready' ? 'wired — review or change' : 'let agents reach you when you step away',
    },
  )
  if (signedIn && hasDevice) {
    options.push({ value: 'devices', label: 'Devices', hint: 'what can receive right now' })
  }
  options.push({ value: 'doctor', label: 'Run diagnostics', hint: 'check every part of the setup' })
  if (signedIn) {
    options.push({ value: 'account', label: 'Account', hint: 'plan, machine, sign out' })
  }
  options.push({ value: 'quit', label: 'Quit' })
  return options
}

// ---------------------------------------------------------------------------
// Test notification
// ---------------------------------------------------------------------------

async function testNotificationScreen(deps: CommandDeps): Promise<void> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const project = config.project.value

  const title = await clack.text({
    message: 'Title',
    placeholder: 'Test from Notifai',
    defaultValue: 'Test from Notifai',
  })
  if (cancelled(title)) return

  const body = await clack.text({
    message: 'Body',
    placeholder: 'If you can read this on your device, it works.',
    defaultValue: 'If you can read this on your device, it works.',
  })
  if (cancelled(body)) return

  const kind = await clack.select<string>({
    message: 'Kind',
    options: [
      { value: 'update', label: 'Update', hint: 'something happened' },
      { value: 'done', label: 'Done', hint: 'work finished' },
    ],
    initialValue: 'done',
  })
  if (cancelled(kind)) return

  clack.log.step('Sending, then waiting for your devices to confirm…')
  const code = await sendCommand(deps, {
    title: String(title),
    body: String(body),
    kind: String(kind),
    ...(project !== null ? { project } : {}),
  })
  if (code === EXIT.ok) clack.log.success('Delivered. Check the device it landed on.')
  else clack.log.error('That did not get through — `Run diagnostics` will say why.')
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

async function devicesScreen(deps: CommandDeps): Promise<void> {
  const spinner = clack.spinner()
  spinner.start('Loading your devices')
  const devices = await deviceInventory(deps)
  spinner.stop(style.dim('Devices loaded'))

  if (devices === null) {
    clack.log.warn('Could not reach the service. Sign in, or check the connection.')
    return
  }
  if (devices.length === 0) {
    clack.note(
      'No devices are registered yet.\n\n' +
        'Install a supported Notifai Companion App, sign in with the same\n' +
        'Account, and allow notifications when it asks.',
      'No devices',
    )
    return
  }

  const body = devices
    .map((device) => {
      const ready = canDeviceReceive(device)
      const detail = ready ? 'ready' : `not ready ${glyph.bullet} permission: ${device.permission_status}`
      return (
        `${mark(ready ? 'ok' : 'warn')}  ${style.value(device.display_name)} ${style.dim(`(${device.platform})`)}\n` +
        `   ${style.dim(detail)}\n` +
        `   ${style.dim(device.device_id)}`
      )
    })
    .join('\n\n')
  clack.note(body, `${devices.length} device${devices.length === 1 ? '' : 's'}`)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function settingsScreen(deps: CommandDeps): Promise<'unchanged' | 'local' | 'remote'> {
  let result: 'unchanged' | 'local' | 'remote' = 'unchanged'
  for (;;) {
    const config = loadConfig({ cwd: deps.cwd, env: deps.env })
    const group = await clack.select<ConfigGroup | 'back'>({
      message: 'Settings',
      options: [
        ...CONFIG_GROUPS.map((entry) => ({
          value: entry.id,
          label: entry.title,
          hint: changedCount(config, entry.id),
        })),
        { value: 'back' as const, label: '← Back' },
      ],
    })
    if (cancelled(group) || group === 'back') return result
    const next = await settingsGroupScreen(deps, group as ConfigGroup)
    if (next === 'remote') result = 'remote'
    else if (next === 'local' && result === 'unchanged') result = 'local'
  }
}

/** "3 changed" beats repeating the group blurb the reader already saw. */
function changedCount(config: CliConfig, group: ConfigGroup): string {
  const keys = configKeysByGroup(group)
  const changed = keys.filter((info) => config[info.key].source !== 'default').length
  return changed === 0 ? style.dim('all default') : style.dim(`${changed} changed`)
}

async function settingsGroupScreen(
  deps: CommandDeps,
  group: ConfigGroup,
): Promise<'unchanged' | 'local' | 'remote'> {
  let result: 'unchanged' | 'local' | 'remote' = 'unchanged'
  for (;;) {
    const config = loadConfig({ cwd: deps.cwd, env: deps.env })
    const info = CONFIG_GROUPS.find((entry) => entry.id === group)!
    const keys = configKeysByGroup(group)

    const key = await clack.select<ConfigKey | 'back'>({
      message: info.title,
      options: [
        ...keys.map((entry) => {
          const resolved = config[entry.key]
          const source = describeSource(resolved.source)
          const value = formatValue(entry.key, resolved.value)
          return {
            value: entry.key,
            label: entry.label,
            hint: source.label === 'default' ? style.dim(value) : `${value} ${style.dim(`(${source.label})`)}`,
          }
        }),
        { value: 'back' as const, label: '← Back' },
      ],
    })
    if (cancelled(key) || key === 'back') return result
    const next = await settingDetailScreen(deps, key as ConfigKey)
    if (next === 'remote') result = 'remote'
    else if (next === 'local' && result === 'unchanged') result = 'local'
  }
}

/**
 * One key, fully explained, with the option to change it.
 *
 * This is where the paragraph lives. Everything above stayed one line per key
 * so that arriving here means the reader has already said which key they care
 * about.
 */
async function settingDetailScreen(
  deps: CommandDeps,
  key: ConfigKey,
): Promise<'unchanged' | 'local' | 'remote'> {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const info = configInfo(key)
  const resolved = config[key]
  const source = describeSource(resolved.source)

  const lines = [
    info.detail,
    '',
    `${style.dim('Now')}      ${style.value(formatValue(key, resolved.value))}  ${style.dim(`${glyph.bullet} ${source.label}`)}`,
    `${style.dim('Accepts')}  ${acceptedValues(key)}`,
    `${style.dim('Key')}      ${style.code(key)}`,
  ]
  clack.note(lines.join('\n'), info.label)

  const action = await clack.select<'change' | 'back'>({
    message: 'Change it?',
    options: [
      // Not lower-cased: "Change only when i have stepped away" is what
      // `toLowerCase` makes of a label that starts a sentence.
      { value: 'change', label: `Change this setting`, hint: style.code(info.key) },
      { value: 'back', label: '← Back' },
    ],
    initialValue: 'back',
  })
  if (cancelled(action) || action === 'back') return 'unchanged'

  const value = await promptForValue(deps, key)
  if (value === null) return 'unchanged'

  const layer = await chooseLayer()
  if (layer === null) return 'unchanged'

  const code = await configSetCommand(deps, key, value, {
    yes: true,
    ...(layer === 'project' ? { project: true } : {}),
    ...(layer === 'local' ? { local: true } : {}),
  })
  if (code !== EXIT.ok) return 'unchanged'
  clack.log.success(`${info.label} is now ${formatValueRaw(key, value)}`)
  return 'local'
}

function formatValueRaw(key: ConfigKey, raw: string): string {
  const info = configInfo(key)
  if (info.kind === 'boolean') return raw === 'true' ? 'yes' : 'no'
  return raw
}

/** The prompt shape follows the key's type; validation stays in `config set`. */
async function promptForValue(deps: CommandDeps, key: ConfigKey): Promise<string | null> {
  const info = configInfo(key)

  if (info.kind === 'boolean') {
    const answer = await clack.select<string>({
      message: info.label,
      options: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ],
    })
    return cancelled(answer) ? null : String(answer)
  }

  if (info.kind === 'enum') {
    const answer = await clack.select<string>({
      message: info.label,
      options: (info.choices ?? []).map((choice) => ({
        value: choice,
        label: choice,
        ...(info.choiceHints?.[choice] !== undefined ? { hint: info.choiceHints[choice]! } : {}),
      })),
    })
    return cancelled(answer) ? null : String(answer)
  }

  // The one key whose legal values the machine knows better than the reader.
  if (key === 'devices') return await promptForDevices(deps)

  const bounds = boundsHint(key)
  const answer = await clack.text({
    message: info.label,
    ...(info.example !== undefined ? { placeholder: info.example } : {}),
    validate: (input) => {
      const trimmed = (input ?? '').trim()
      if (trimmed === '') return 'Enter a value, or press Escape to go back.'
      if (info.kind === 'integer') {
        if (!/^-?\d+$/.test(trimmed)) return `${info.label} is a whole number of seconds.`
        const range = boundsRange(key)
        if (bounds !== null && range !== null) {
          const parsed = Number(trimmed)
          if (parsed < range.min || parsed > range.max) return `Must be between ${bounds}.`
        }
      }
      if (info.kind === 'url' && !/^https?:\/\//.test(trimmed)) return 'Must start with http:// or https://.'
      return undefined
    },
  })
  return cancelled(answer) ? null : String(answer).trim()
}

function boundsRange(key: ConfigKey): { min: number; max: number } | null {
  const hint = boundsHint(key)
  if (hint === null) return null
  const [min, max] = hint.replace(/[^\d–]/g, '').split('–')
  if (min === undefined || max === undefined) return null
  return { min: Number(min), max: Number(max) }
}

async function promptForDevices(deps: CommandDeps): Promise<string | null> {
  const spinner = clack.spinner()
  spinner.start('Loading your devices')
  const devices = await deviceInventory(deps)
  spinner.stop(style.dim('Devices loaded'))
  if (devices === null || devices.length === 0) {
    clack.log.warn('No devices to choose from yet.')
    return null
  }
  const picked = await clack.multiselect<string>({
    message: 'Which devices should receive by default?',
    options: devices.map((device) => ({
      value: device.device_id,
      label: device.display_name,
      hint: canDeviceReceive(device) ? device.platform : `${device.platform} ${glyph.bullet} not ready`,
    })),
    required: true,
  })
  return cancelled(picked) ? null : (picked as string[]).join(',')
}

/**
 * Which layer the value lands in.
 *
 * Asked every time rather than defaulting, because the difference between
 * "my machine" and "everyone who clones this repository" is not recoverable by
 * guessing, and the shared file is the one that ends up in a commit.
 */
async function chooseLayer(): Promise<'global' | 'project' | 'local' | null> {
  const layer = await clack.select<'global' | 'project' | 'local'>({
    message: 'Where should this apply?',
    options: [
      { value: 'global', label: 'This machine', hint: 'every project you work on here' },
      { value: 'project', label: 'This project, shared', hint: '.notifai/config.toml — commit it' },
      { value: 'local', label: 'This project, just me', hint: 'stored on this machine, not in the repo' },
    ],
    initialValue: 'global',
  })
  return cancelled(layer) ? null : (layer as 'global' | 'project' | 'local')
}

// ---------------------------------------------------------------------------
// Question routing
// ---------------------------------------------------------------------------

/**
 * Which harnesses are wired, without the install paths.
 *
 * The underlying state lists every installation with its absolute file path,
 * which is the right level of detail for `doctor` and far too much for a
 * summary card — four paths wrap across six lines and push the settings
 * underneath them out of alignment.
 */
function wiringSummary(hooks: ReadinessState | undefined): string {
  if (hooks === undefined) return 'unknown'
  const named = hooks.detail.replace(/\s*\([^)]*\)/g, '').trim()
  return named === '' ? hooks.detail : named
}

/** Returns true when something changed and the status card needs refreshing. */
async function routingScreen(deps: CommandDeps, readiness: Readiness): Promise<boolean> {
  const hooks = stateById(readiness, 'hooks')
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const installations = findInstallations(deps.env, deps.hookAdapterHome)

  const row = (label: string, value: string): string => `${style.dim(label.padEnd(16))}${value}`
  clack.note(
    'When an agent registers a question, it appears in your terminal first.\n' +
      'After the grace below, it goes to your Companion devices as a\n' +
      'notification with a supported native or in-app answer surface, and\n' +
      'your answer comes back to the agent —\n' +
      'whether or not you are still at this machine.\n\n' +
      [
        row('Wired to', wiringSummary(hooks)),
        row('Send', config.ask_notifications.value ? 'yes' : 'no — questions stay in the terminal'),
        row('Grace', formatValue('ask_grace_seconds', config.ask_grace_seconds.value)),
      ].join('\n'),
    'Question routing',
  )

  const action = await clack.select<RoutingAction>({
    message: 'Question routing',
    options: routingHookActions({
      canInstall: detectedHarnesses(deps.cwd, deps.env).length > 0,
      installations,
      hooksReady: hooks?.status === 'ready',
    }),
  })
  if (cancelled(action) || action === 'back') return false

  if (action === 'settings') {
    await settingsGroupScreen(deps, 'questions')
    return true
  }

  if (action === 'install') {
    hooksInstallCommand(deps, {})
    return true
  }
  for (const installation of installations) {
    hooksUninstallCommand(deps, { harness: installation.harness })
  }
  return true
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/** Returns true when something changed and the status card needs refreshing. */
async function accountScreen(deps: CommandDeps, readiness: Readiness): Promise<boolean> {
  const signedIn = stateById(readiness, 'credential')?.status === 'ready'

  if (!signedIn) {
    await initCommand(deps, {})
    return true
  }

  const auth = stateById(readiness, 'auth')
  const credential = stateById(readiness, 'credential')
  clack.note(
    `${style.dim('Machine')}  ${credential?.detail ?? 'unknown'}\n${style.dim('Account')}  ${auth?.detail ?? 'unknown'}`,
    'Account',
  )

  const action = await clack.select<'relogin' | 'logout' | 'back'>({
    message: 'Account',
    options: [
      { value: 'relogin', label: 'Pair this machine again' },
      { value: 'logout', label: 'Sign out', hint: 'removes the stored credential' },
      { value: 'back', label: '← Back' },
    ],
    initialValue: 'back',
  })
  if (cancelled(action) || action === 'back') return false

  if (action === 'logout') {
    const sure = await clack.confirm({ message: 'Remove the stored credential?', initialValue: false })
    if (cancelled(sure) || sure !== true) return false
    logoutCommand(deps)
    return true
  }

  await loginCommand(deps, {})
  return true
}
