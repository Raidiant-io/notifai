import { unlinkSync } from 'node:fs'
import { type LogLevel } from './config.js'
import {
  LOG_EVENTS,
  RECORD_LEVELS,
  activeLogPath,
  archiveLogPaths,
  logsDiskUsage,
  readLogRecords,
  renderRecord,
  type LogQuery,
} from './logging.js'
import { EXIT, loadLoggedConfig, type CommandDeps } from './commands-core.js'

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

export interface LogsFlags {
  json?: boolean
  limit?: number
  all?: boolean
  since?: string
  level?: string
  event?: string[]
  run?: string
  request?: string
  session?: string
  project?: string
  allProjects?: boolean
  grep?: string
  path?: boolean
  clear?: boolean
}

const LOG_RECORD_OPTIONS: readonly (readonly [keyof LogsFlags, string])[] = [
  ['limit', '--limit'],
  ['all', '--all'],
  ['since', '--since'],
  ['level', '--level'],
  ['event', '--event'],
  ['run', '--run'],
  ['request', '--request'],
  ['session', '--session'],
  ['project', '--project'],
  ['allProjects', '--all-projects'],
  ['grep', '--grep'],
]

/**
 * Deliberately small. The reader is usually a model with a finite context, and
 * a log command whose default answer is ten thousand lines gets used once.
 * Everything beyond this is reachable by asking for it.
 */
const DEFAULT_LOG_LIMIT = 30
/** Even `--all` stops somewhere; an unbounded dump is never the useful answer. */
const MAX_LOG_LIMIT = 2_000

/** `10m`, `2h`, `1d`, or an ISO 8601 instant. */
export function parseSince(raw: string, now: number): number | null {
  const relative = /^(\d+)([smhd])$/.exec(raw.trim())
  if (relative !== null) {
    const amount = Number(relative[1])
    const unit = relative[2] as 's' | 'm' | 'h' | 'd'
    const seconds = { s: 1, m: 60, h: 3600, d: 86400 }[unit]
    return now - amount * seconds * 1000
  }
  const absolute = Date.parse(raw)
  return Number.isNaN(absolute) ? null : absolute
}

/**
 * What this machine recorded about itself.
 *
 * The retrieval half of the local log, and the half that decides whether the
 * log is worth having. Three things make it usable by an agent rather than
 * merely available to one: the default is bounded and scoped to this project,
 * the filters match the questions actually asked ("that run", "that
 * notification", "just the failures"), and `--json` gives the machine the
 * records untouched on stdout while every word of explanation goes to stderr.
 */
export function logsCommand(deps: CommandDeps, flags: LogsFlags): number {
  const selectedRetrievalOptions = LOG_RECORD_OPTIONS
    .filter(([key]) => {
      const value = flags[key]
      return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false
    })
    .map(([, name]) => name)

  if (flags.path === true && flags.clear === true) {
    deps.io.err('Pass --path or --clear, not both.')
    return EXIT.usage
  }
  if (flags.path === true && selectedRetrievalOptions.length > 0) {
    deps.io.err(`--path cannot be combined with record options: ${selectedRetrievalOptions.join(', ')}.`)
    return EXIT.usage
  }
  if (flags.clear === true && selectedRetrievalOptions.length > 0) {
    deps.io.err(`--clear cannot be combined with record options: ${selectedRetrievalOptions.join(', ')}.`)
    return EXIT.usage
  }
  if (flags.project !== undefined && flags.allProjects === true) {
    deps.io.err('Pass --project or --all-projects, not both.')
    return EXIT.usage
  }
  if (flags.limit !== undefined && flags.all === true) {
    deps.io.err('Pass --limit or --all, not both.')
    return EXIT.usage
  }
  if (flags.limit !== undefined && (!Number.isInteger(flags.limit) || flags.limit <= 0)) {
    deps.io.err('--limit must be a positive integer.')
    return EXIT.usage
  }
  if (flags.limit !== undefined && flags.limit > MAX_LOG_LIMIT) {
    deps.io.err(`--limit cannot exceed ${MAX_LOG_LIMIT}; narrow the result with --since or filters.`)
    return EXIT.usage
  }

  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const now = (deps.now ?? Date.now)()

  if (flags.path === true) {
    const usage = logsDiskUsage(deps.env)
    const archives = archiveLogPaths(deps.env)
    if (flags.json === true) {
      deps.io.out(
        JSON.stringify(
          {
            active: activeLogPath(deps.env),
            archives,
            files: usage.files,
            bytes: usage.bytes,
            level: config.log_level.value,
            max_bytes: config.log_max_bytes.value,
            max_files: config.log_max_files.value,
            local_only: true,
          },
          null,
          2,
        ),
      )
      return EXIT.ok
    }
    deps.io.out(activeLogPath(deps.env))
    for (const archive of archives) deps.io.out(archive)
    deps.io.err(
      `${usage.files} file(s), ${Math.round(usage.bytes / 1024)} KB, level ${config.log_level.value}. These stay on this machine.`,
    )
    return EXIT.ok
  }

  if (flags.clear === true) {
    let removed = 0
    for (const file of [activeLogPath(deps.env), ...archiveLogPaths(deps.env)]) {
      try {
        unlinkSync(file)
        removed += 1
      } catch {
        // Absent, or not ours to remove; either way there is nothing to report.
      }
    }
    deps.io.out(
      flags.json === true
        ? JSON.stringify({ cleared_files: removed })
        : `Cleared ${removed} log file${removed === 1 ? '' : 's'}.`,
    )
    return EXIT.ok
  }

  const query: LogQuery = {
    limit: flags.limit ?? (flags.all === true ? MAX_LOG_LIMIT : DEFAULT_LOG_LIMIT),
  }

  if (flags.since !== undefined) {
    const since = parseSince(flags.since, now)
    if (since === null) {
      deps.io.err(`Could not read "${flags.since}" as a time. Use 10m, 2h, 1d, or an ISO 8601 instant.`)
      return EXIT.usage
    }
    query.since = since
  }
  if (flags.level !== undefined) {
    if (!(RECORD_LEVELS as readonly string[]).includes(flags.level)) {
      deps.io.err(`--level takes one of: ${RECORD_LEVELS.join(', ')} — not "${flags.level}".`)
      return EXIT.usage
    }
    query.level = flags.level as LogLevel
  }
  if (flags.event !== undefined && flags.event.length > 0) {
    const unknown = flags.event.filter((name) => !(LOG_EVENTS as readonly string[]).includes(name))
    if (unknown.length > 0) {
      deps.io.err(`Unknown event ${unknown.join(', ')}. Valid: ${LOG_EVENTS.join(', ')}`)
      return EXIT.usage
    }
    query.event = flags.event
  }
  if (flags.run !== undefined) query.run = flags.run
  if (flags.session !== undefined) query.session = flags.session
  if (flags.request !== undefined) query.request = flags.request
  if (flags.grep !== undefined) query.contains = flags.grep

  // Scoped to this project by default. A machine commonly runs several agents
  // in several worktrees at once, and the answer to "what just happened" is
  // useless if three other projects are interleaved through it.
  const scope =
    flags.project ?? (flags.allProjects === true ? undefined : (config.project.value ?? undefined))
  if (scope !== undefined) query.project = scope

  const result = readLogRecords(deps.env, query)

  if (flags.json === true) {
    for (const record of result.records) deps.io.out(JSON.stringify(record))
  } else {
    for (const record of result.records) deps.io.out(renderRecord(record))
  }

  if (result.records.length === 0) {
    if (config.log_level.value === 'off') {
      deps.io.err('Nothing is being recorded: log_level is off.')
      deps.io.err('Turn it on with `notifai config set log_level info --yes`.')
    } else if (logsDiskUsage(deps.env).files === 0) {
      deps.io.err('No log yet. It is written the next time a notifai command or harness hook runs.')
    } else {
      deps.io.err('No records matched. Widen it with --all-projects, --since 1d, or --all.')
    }
    return EXIT.ok
  }

  // Everything explanatory goes to stderr so `--json` leaves stdout as clean
  // JSONL for whatever is parsing it.
  const notes: string[] = []
  if (scope !== undefined) notes.push(`project ${scope} (--all-projects for every project)`)
  if (result.more) {
    notes.push(
      query.limit! < MAX_LOG_LIMIT
        ? `more history behind this (-n ${Math.min(query.limit! * 4, MAX_LOG_LIMIT)} or --all)`
        : `more history exists beyond the ${MAX_LOG_LIMIT}-record safety cap; narrow with --since or filters`,
    )
  }
  if (config.log_level.value !== 'debug') notes.push('`log_level = debug` records request detail')
  if (notes.length > 0) deps.io.err(`— ${result.records.length} records; ${notes.join('; ')}`)
  return EXIT.ok
}
