/**
 * What every configuration key means, in the reader's words.
 *
 * `config.ts` already documented all fourteen keys carefully — but in TypeScript
 * comments, which is the one audience that never needed them. Someone running
 * `notifai config show` saw `require_idle = true` and had no way to learn what
 * it did short of reading the source, so this module is that knowledge moved to
 * where it can be printed.
 *
 * It is the single source for `config show`, `config set`'s errors, `config
 * explain`, the help footer, and the interactive settings screen. One
 * description, rendered five ways, so the surfaces cannot disagree.
 *
 * `summary` is the one-line form that fits beside a value in a list.
 * `detail` is the paragraph shown once the reader has asked for this key
 * specifically — progressive disclosure, so a list of fourteen settings stays
 * a list and not an essay.
 */
import { CLI_SOUNDS, INTERRUPTION_LEVELS } from '@raidiant/notifai-protocol'
import { LOG_LEVELS, configBounds, type ConfigKey } from './config.js'

export type ConfigKind = 'string' | 'url' | 'integer' | 'boolean' | 'enum' | 'list'

/**
 * Which surface a key belongs to. Grouping is the difference between fourteen
 * flat keys and four short lists a reader can hold in their head.
 */
export type ConfigGroup = 'questions' | 'delivery' | 'project' | 'diagnostics' | 'connection'

export const CONFIG_GROUPS: { id: ConfigGroup; title: string; blurb: string }[] = [
  {
    id: 'questions',
    title: 'Questions & presence',
    blurb: 'When a question an agent registered is allowed to leave this terminal and reach your devices.',
  },
  {
    id: 'delivery',
    title: 'Delivery defaults',
    blurb: 'What a notification looks and behaves like when a command does not say otherwise.',
  },
  {
    id: 'project',
    title: 'This project',
    blurb: 'How work in this directory identifies itself, and the house rules agents read before notifying.',
  },
  {
    id: 'diagnostics',
    title: 'Local logs',
    blurb: 'What this machine records about its own activity, so an agent can find out afterwards what happened.',
  },
  {
    id: 'connection',
    title: 'Connection',
    blurb: 'Which Notifai service this machine talks to. Most people never change this.',
  },
]

export interface ConfigKeyInfo {
  key: ConfigKey
  /** Human words for the key, used as a list label. */
  label: string
  group: ConfigGroup
  kind: ConfigKind
  /** One line. Must fit beside a value without wrapping on an 80-column terminal. */
  summary: string
  /** The full explanation, shown when the reader asks about this key. */
  detail: string
  /** Allowed values for `enum`. */
  choices?: readonly string[]
  /** What a choice means, keyed by choice. */
  choiceHints?: Record<string, string>
  /** Unit suffix rendered after numbers, e.g. `s`. */
  unit?: string
  /** What the key means when it holds no value. */
  unsetMeans?: string
  /** A valid value, for error messages and placeholders. */
  example?: string
  /**
   * Advanced keys are hidden behind an explicit reveal in the interactive
   * settings screen. They are still listed by `config show` — hiding a value
   * that is in force would be worse than showing one nobody needs.
   */
  advanced?: boolean
}

const INFO: Record<ConfigKey, Omit<ConfigKeyInfo, 'key'>> = {
  ask_notifications: {
    label: 'Send questions to my devices',
    group: 'questions',
    kind: 'boolean',
    summary: 'Whether a registered question may reach your phone and Mac at all',
    detail:
      'The master switch for question routing. When this is off, a question an agent registers with `notifai ask` stays in the terminal and never leaves this machine, whatever the presence settings say. Turn it off to stop being reached for a while without uninstalling the harness hooks.',
    example: 'true',
  },
  require_idle: {
    label: 'Only when I have stepped away',
    group: 'questions',
    kind: 'boolean',
    summary: 'Whether sitting at this keyboard holds a question back',
    detail:
      'Off (the default) means notify me even while I am using this machine. `ask_grace_seconds` still runs, so the terminal is offered the question first; I just do not need to walk away before it may leave. Turn this on when local keyboard or mouse activity should keep questions in the terminal.\n\nThis is separate from `ask_notifications`, which switches routing off altogether: wanting to be reached only while away is different from not wanting to be reached.',
    example: 'false',
  },
  away_after_seconds: {
    label: 'Away after',
    group: 'questions',
    kind: 'integer',
    unit: 's',
    summary: 'Keyboard and mouse idle time before this machine counts as unattended',
    detail:
      'How long the keyboard and mouse must be quiet before you count as away. Only consulted while `require_idle` is on.\n\nWhere the operating system exposes no idle signal, silence since your last prompt is used instead, which is the conservative reading.',
    example: '120',
  },
  ask_grace_seconds: {
    label: 'Terminal-first grace',
    group: 'questions',
    kind: 'integer',
    unit: 's',
    summary: 'Optional delay before a question may reach your devices',
    detail:
      'Zero (the default) sends the question to your devices as soon as the agent turn ends. Set a positive duration to offer the terminal an exclusive answer window first; the timer is measured from the moment the agent asked.\n\nA timer and nothing more. It is honoured whether or not presence is consulted at all, because how long to wait and whether anyone is watching are separate questions, and answering one should not answer the other.',
    example: '0',
  },
  hook_reply_timeout_seconds: {
    label: 'Hook wait for an answer',
    group: 'questions',
    kind: 'integer',
    unit: 's',
    summary: 'How long the harness hook blocks waiting for your answer',
    detail:
      'After a question has gone out, the harness hook holds the agent for up to this long waiting for your answer before falling through to the harness\'s own prompt.\n\nThe ceiling exists because both Claude Code and Codex kill a command hook at 600 seconds. Grace plus this value plus the installer\'s headroom has to stay under that, or the hook is killed mid-wait — after you have already answered.',
    example: '180',
  },

  sound: {
    label: 'Sound',
    group: 'delivery',
    kind: 'enum',
    choices: CLI_SOUNDS,
    choiceHints: {
      default: 'the standard notification tone',
      done: 'the completion chime',
      attention: 'used for questions that want an answer',
      alert: 'the most insistent tone',
      none: 'silent — arrives without a sound',
    },
    summary: 'Override the sound every notification uses',
    detail:
      'Normally the sound comes from what the notification is: progress updates are silent, completions get the done chime, questions get the attention tone. Setting this pins one sound for everything sent from here, overriding those profiles.\n\nA common use is `none`, to make a noisy project completely silent.',
    unsetMeans: 'each notification uses the sound for its kind',
  },
  interruption_level: {
    label: 'Interruption level',
    group: 'delivery',
    kind: 'enum',
    choices: INTERRUPTION_LEVELS,
    choiceHints: {
      passive: 'no sound or wake — waits in the notification list',
      active: 'wakes the screen and plays the sound',
      time_sensitive: 'may break through Focus modes',
    },
    summary: 'Override how insistently notifications arrive',
    detail:
      'How hard a notification tries to reach you, in the operating system\'s terms. Like the sound, this is normally decided by what the notification is; setting it pins one level for everything.\n\n`time_sensitive` can pierce a Focus mode, so it is worth reserving for the cases that genuinely earn it.',
    unsetMeans: 'each notification uses the level for its kind',
  },
  devices: {
    label: 'Default devices',
    group: 'delivery',
    kind: 'list',
    summary: 'Which of your devices receive by default',
    detail:
      'A comma-separated list of device ids. When set, notifications go only to these devices unless a command overrides it.\n\nRun `notifai devices` to see the ids and which of them can currently receive.',
    unsetMeans: 'every device that can receive',
    example: 'dev_abc123,dev_def456',
  },
  ttl_seconds: {
    label: 'Delivery window',
    group: 'delivery',
    kind: 'integer',
    unit: 's',
    summary: 'How long the service keeps trying to deliver before giving up',
    detail:
      'A notification for a device that is off or offline is held for this long and delivered when the device reappears. After it lapses the notification is dropped rather than arriving stale.\n\nThe default of 86400 is one day.',
    example: '86400',
  },
  wait_seconds: {
    label: 'Wait for outcomes',
    group: 'delivery',
    kind: 'integer',
    unit: 's',
    summary: 'How long `send` waits to report what happened to a notification',
    detail:
      'After a notification is accepted, `notifai send` can wait for the delivery outcome so its exit code reflects what actually happened rather than only that the service took it.\n\nSet to 0 to return as soon as the service accepts, which is the fastest option and the one that tells you least.',
    example: '10',
  },
  collapse_key: {
    label: 'Collapse key',
    group: 'delivery',
    kind: 'string',
    summary: 'Replace earlier notifications carrying the same key',
    detail:
      'Two notifications sharing a collapse key do not stack — the newer one replaces the older on the lock screen. This is how a status that changes repeatedly stays one line instead of becoming twenty.\n\nSetting it here applies one key to everything sent from here, which is usually too broad; most uses pass `--collapse-key` per send instead.',
    unsetMeans: 'each notification stands on its own',
    advanced: true,
  },

  project: {
    label: 'Project id',
    group: 'project',
    kind: 'string',
    summary: 'The name this project reports itself as',
    detail:
      'Stamped on every notification sent from this directory, and how the companion apps group and filter what arrives. Normally set once in `.notifai/config.toml` and committed, so everyone working on the repository reports the same name.',
    unsetMeans: 'notifications arrive without a project',
    example: 'my-app',
  },
  notify_criteria: {
    label: 'House rules for agents',
    group: 'project',
    kind: 'string',
    summary: 'Free text an agent reads before deciding whether to notify you',
    detail:
      'Your own guidance, in your own words, about what is worth a notification in this project — read by agents before they send. Something like "only tell me about failures and finished deploys; never per-file progress".\n\nIt is advice to the agent, not a filter the service enforces.',
    unsetMeans: 'agents fall back to their default judgement',
    example: 'Only failures and completed deploys',
  },

  log_level: {
    label: 'Log level',
    group: 'diagnostics',
    kind: 'enum',
    choices: LOG_LEVELS,
    choiceHints: {
      off: 'record nothing',
      error: 'only failures',
      info: 'commands, notifications, and every question decision',
      debug: 'adds config resolution and per-request detail',
    },
    summary: 'How much this machine records about what it did',
    detail:
      'Notifai keeps a local record of what it did — every command, every notification, and in particular every decision a harness hook made about whether a question could leave the terminal. Hooks run headless, so without this there is no account of them at all: `notifai logs` is how an agent finds out afterwards why a question never reached your phone.\n\nThe log never leaves this machine. It is not uploaded, and nothing sends it anywhere.\n\n`debug` also records which config layer won and the detail of each request, which is what to turn on when something is behaving in a way the ordinary log does not explain.',
    example: 'info',
  },
  log_max_bytes: {
    label: 'Log file size',
    group: 'diagnostics',
    kind: 'integer',
    summary: 'How large the log grows before it is rotated',
    detail:
      'When the active log reaches this size it is renamed aside and a fresh one starts. Together with the number of files kept, this is the whole disk budget: nothing here grows without a ceiling.',
    advanced: true,
    example: '2000000',
  },
  log_max_files: {
    label: 'Log files kept',
    group: 'diagnostics',
    kind: 'integer',
    summary: 'How many rotated log files are kept before the oldest is deleted',
    detail:
      'Counts the active file. At the defaults — three files of two megabytes — the logs occupy about six megabytes, which is weeks of ordinary agent traffic.\n\nRaise it when you need to look further back than the log currently reaches; lower it to one to keep only the file being written.',
    advanced: true,
    example: '3',
  },

  base_url: {
    label: 'Service URL',
    group: 'connection',
    kind: 'url',
    summary: 'Which Notifai service this machine talks to',
    detail:
      'Points the CLI at a Notifai service. The default is the hosted service, and signing in stores the URL the credential belongs to, so this rarely needs setting by hand.\n\nChanging it does not move your credential: a URL that does not match the one you paired against will not authenticate.',
    advanced: true,
    example: 'https://notifai.fly.dev',
  },
}

export function configInfo(key: ConfigKey): ConfigKeyInfo {
  return { key, ...INFO[key] }
}

/** Every key in its group, in the order a reader should meet them. */
export function configKeysByGroup(group: ConfigGroup): ConfigKeyInfo[] {
  return (Object.keys(INFO) as ConfigKey[])
    .filter((key) => INFO[key].group === group)
    .map((key) => configInfo(key))
}

/** Bounds rendered the way an error message wants them, or null. */
export function boundsHint(key: ConfigKey): string | null {
  const bounds = configBounds(key)
  if (bounds === undefined) return null
  const info = INFO[key]
  const unit = info.unit ?? ''
  return `${bounds.min}${unit}–${bounds.max}${unit}`
}

/** What a `config set` caller may legally pass, phrased for an error message. */
export function acceptedValues(key: ConfigKey): string {
  const info = INFO[key]
  switch (info.kind) {
    case 'boolean':
      return 'true or false'
    case 'enum':
      return (info.choices ?? []).join(', ')
    case 'integer': {
      const bounds = boundsHint(key)
      return bounds === null ? 'a whole number' : `a whole number from ${bounds}`
    }
    case 'list':
      return 'a comma-separated list'
    case 'url':
      return 'a URL'
    case 'string':
      return 'any text'
  }
}

/** How a resolved value should read in a list. */
export function formatValue(key: ConfigKey, value: unknown): string {
  const info = INFO[key]
  if (value === null || value === undefined) return info.unsetMeans ?? 'not set'
  if (Array.isArray(value)) return value.length === 0 ? (info.unsetMeans ?? 'not set') : value.join(', ')
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number' && info.unit !== undefined) return formatDuration(value, info.unit)
  return String(value)
}

/**
 * Where a value came from, in words rather than in a tagged path.
 *
 * `global:/Users/you/.config/notifai/config.toml` answers "which file" but not
 * "why is this the value" — and the second question is the one someone reading
 * `config show` is actually asking. The path is still available for anyone
 * about to edit the file; it is just no longer the whole answer.
 */
export function describeSource(source: string): { label: string; path: string | null } {
  if (source === 'default') return { label: 'default', path: null }
  if (source === 'flag') return { label: 'this command', path: null }
  const separator = source.indexOf(':')
  if (separator === -1) return { label: source, path: null }
  const layer = source.slice(0, separator)
  const filePath = source.slice(separator + 1)
  const labels: Record<string, string> = {
    session: 'this session',
    'project-local': 'this project (personal)',
    project: 'this project (shared)',
    global: 'this machine',
  }
  return { label: labels[layer] ?? layer, path: filePath === '' ? null : filePath }
}

/** Seconds as something a person reads: `300s` is true, `5m` is legible. */
export function formatDuration(value: number, unit: string): string {
  if (unit !== 's') return `${value}${unit}`
  if (value === 0) return '0s (immediately)'
  if (value < 60) return `${value}s`
  if (value % 86400 === 0) return `${value / 86400}d`
  if (value % 3600 === 0) return `${value / 3600}h`
  if (value % 60 === 0) return `${value / 60}m`
  return `${Math.floor(value / 60)}m ${value % 60}s`
}
