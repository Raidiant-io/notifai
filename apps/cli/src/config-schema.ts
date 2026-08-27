/**
 * What every configuration key means, in the reader's words.
 *
 * `config.ts` already documented every key carefully — but in TypeScript
 * comments, which is the one audience that never needed them. Someone running
 * `notifai config show` saw `ask_grace_seconds = 0` and had no way to learn
 * what it did short of reading the source, so this module is that knowledge
 * moved to where it can be printed.
 *
 * It is the single source for `config show`, `config set`'s errors, `config
 * explain`, the help footer, and the interactive settings screen. One
 * description, rendered five ways, so the surfaces cannot disagree.
 *
 * `summary` is the one-line form that fits beside a value in a list.
 * `detail` is the paragraph shown once the reader has asked for this key
 * specifically — progressive disclosure, so the list of settings stays a list
 * and not an essay.
 */
import { CLI_SOUNDS, INTERRUPTION_LEVELS } from '@raidiant/notifai-protocol'
import { LOG_LEVELS, configBounds, type ConfigKey } from './config.js'

export type ConfigKind = 'string' | 'url' | 'integer' | 'boolean' | 'enum' | 'list'

/**
 * Which surface a key belongs to. Grouping is the difference between a flat
 * list of keys and a few short ones a reader can hold in their head.
 */
export type ConfigGroup = 'questions' | 'delivery' | 'project' | 'trust' | 'diagnostics'

export const CONFIG_GROUPS: { id: ConfigGroup; title: string; blurb: string }[] = [
  {
    id: 'questions',
    title: 'Questions',
    blurb: 'Whether a question an agent registered may leave this terminal and reach your devices, and how soon.',
  },
  {
    id: 'delivery',
    title: 'Delivery defaults',
    blurb: 'What a notification looks and behaves like when a command does not say otherwise.',
  },
  {
    id: 'project',
    title: 'This project',
    blurb: 'How work in this directory identifies itself. House rules for agents live in `notifai guidance`.',
  },
  {
    id: 'trust',
    title: 'Network trust',
    blurb: 'Origins this machine may fetch from or open beyond the safe defaults. Only you can widen these — a repository cannot.',
  },
  {
    id: 'diagnostics',
    title: 'Local logs',
    blurb: 'What this machine records about its own activity, so an agent can find out afterwards what happened.',
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
    summary: 'Whether a registered question may reach your Companion devices at all',
    detail:
      'The master switch for question routing. When this is off, a question an agent registers with `notifai ask` stays in the terminal and never leaves this machine, whatever else is configured. Turn it off to stop being reached for a while without uninstalling the harness hooks.',
    example: 'true',
  },
  ask_grace_seconds: {
    label: 'Terminal-first grace',
    group: 'questions',
    kind: 'integer',
    unit: 's',
    summary: 'Optional delay before a question may reach your devices',
    detail:
      'Zero (the default) sends the question to your devices as soon as the agent turn ends. Set a positive duration to offer the terminal an exclusive answer window first; the timer is measured from the moment the agent asked.\n\nThis controls when the question reaches devices, not how the harness keeps the Agent Session available afterward. Claude Code waits out of band; Codex holds the asking turn.',
    example: '0',
  },

  reply_window_seconds: {
    label: 'How long an answer is accepted',
    group: 'questions',
    kind: 'integer',
    unit: 's',
    summary: 'How long the service keeps accepting your answer to a question',
    detail:
      'A question stays answerable for this long after it reaches the service. The default is a day, so a question that arrives while you are away is still yours to answer when you come back.\n\nQuestion Routing keeps the exact Agent Session available for this complete window. Claude Code waits out of band and wakes the Agent Session; Codex keeps its turn held. This is separate from `--reply-timeout`, which controls how long a direct `send --reply` command blocks.',
    example: '86400',
  },

  sound: {
    label: 'Sound',
    group: 'delivery',
    kind: 'enum',
    choices: CLI_SOUNDS,
    choiceHints: {
      default: 'the standard notification tone',
      done: 'the completion chime',
      attention: 'a distinct attention tone',
      alert: 'the most insistent tone',
      none: 'silent — arrives without a sound',
    },
    summary: 'Set the sound notifications from here use',
    detail:
      'Setting this pins one sound for every notification sent from here, whatever kind it is.\n\nLeave it unset and each notification arrives with the sound its kind implies: the completion chime when work finished, the most insistent tone when it failed, a distinct attention tone for a question or blocked work, and the standard tone for ordinary news. A common explicit preference is `none`, to make a noisy project completely silent.',
    unsetMeans: 'not set; each kind brings its own sound',
  },
  interruption_level: {
    label: 'Interruption level',
    group: 'delivery',
    kind: 'enum',
    choices: INTERRUPTION_LEVELS,
    choiceHints: {
      passive: 'no sound or wake — waits in the notification list',
      active: 'wakes the screen and plays the sound',
      time_sensitive: 'marks the notification urgent; Focus breakthrough is not available yet',
    },
    summary: 'Set how insistently notifications reach Apple devices',
    detail:
      'Apple interruption level controls how hard a notification tries to reach you in the operating system\'s terms. Setting this pins one Apple-only level for sends from here; kind chooses the sound, never this. Android does not accept caller-selected interruption levels: its product-owned channels and your device settings own attention.\n\nLeave this unset to omit the field and let each destination use its normal behavior. `time_sensitive` is accepted on Apple platforms and marks the notification urgent, but Focus breakthrough is not available yet — run `notifai capabilities --platform <platform>` for the exact contract.',
    unsetMeans: 'not specified; each destination uses its normal behavior',
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
      'Stamped on every notification sent from this directory, and how the companion apps group and filter what arrives. When unset, the CLI infers a stable identifier from Git (shared across linked worktrees) or the current directory. Set it in `.notifai/config.toml` only when that inferred name is not the identity you want.',
    unsetMeans: 'inferred from Git or the current directory',
    example: 'my-app',
  },
  media_origins: {
    label: 'Extra image origins',
    group: 'trust',
    kind: 'list',
    summary: 'Origins remote --image URLs may use beyond public HTTPS',
    detail:
      'By default a remote `--image` URL must be HTTPS to a publicly routable host, and every redirect hop is held to the same rule — an agent given a hostile URL cannot be used to reach this machine\'s local network. List an exact origin (`scheme://host[:port]`) here to allow a self-hosted or intranet image server, including plain-http ones.\n\nThis key is yours alone: it is read from your machine and personal-project configuration and ignored in the repository\'s shared `.notifai/config.toml`, so a cloned repository can never widen it.',
    unsetMeans: 'public HTTPS only',
    example: 'http://imgs.intranet.example:8080',
    advanced: true,
  },
  approve_origins: {
    label: 'Extra approval origins',
    group: 'trust',
    kind: 'list',
    summary: 'Dashboard origins a pairing approval link may open',
    detail:
      'During `notifai login` the server names the browser page where you approve this machine. The CLI opens that link only when it is the Notifai dashboard, the origin you are pairing with, or loopback. If you self-host with the dashboard on its own origin, list that exact origin (`scheme://host[:port]`) here.\n\nThis key is yours alone: it is read from your machine and personal-project configuration and ignored in the repository\'s shared `.notifai/config.toml`, so a cloned repository can never widen it.',
    unsetMeans: 'the Notifai dashboard, the pairing origin, and loopback',
    example: 'https://dash.selfhost.example',
    advanced: true,
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
      'Notifai keeps a local record of what it did — every command, every notification, and in particular every decision a harness hook made about whether a question could leave the terminal. Hooks run headless, so without this there is no account of them at all: `notifai logs` is how an agent finds out afterwards why a question never reached your device.\n\nThe log never leaves this machine. It is not uploaded, and nothing sends it anywhere.\n\n`debug` also records which config layer won and the detail of each request, which is what to turn on when something is behaving in a way the ordinary log does not explain.',
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
  if (source === 'env') return { label: 'environment', path: null }
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
