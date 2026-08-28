import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { ensurePrivateDirectory } from './atomic-file.js'
import { acceptedValues, configInfo } from './config-schema.js'
import {
  BOOLEAN_CONFIG_KEYS,
  CONFIG_KEYS,
  NUMERIC_CONFIG_KEYS,
  ORIGIN_LIST_CONFIG_KEYS,
  USER_OWNED_CONFIG_KEYS,
  configBounds,
  configDefaultValue,
  findProjectConfigPath,
  globalConfigPath,
  personalProjectConfigPath,
  sessionConfigPath,
  type ConfigKey,
} from './config.js'
import { normalizeOrigin } from './url-policy.js'
import { renderConfigExplain, renderConfigList, renderConfigPlain } from './ui/config-view.js'
import { EXIT, loadLoggedConfig, type CommandDeps } from './commands-core.js'
import { isCliSoundRef } from './sound-ref.js'

// ---------------------------------------------------------------------------
// config show / set / unset
// ---------------------------------------------------------------------------

export function configShowCommand(
  deps: CommandDeps,
  flags: { json?: boolean; explain?: boolean; plain?: boolean },
): number {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  if (flags.json) {
    const output = Object.fromEntries(
      CONFIG_KEYS.map((key) => [
        key,
        {
          value: config[key].value,
          source: config[key].source,
          summary: configInfo(key).summary,
        },
      ]),
    )
    deps.io.out(JSON.stringify(output, null, 2))
    return EXIT.ok
  }
  // Anything that is not a person at a terminal keeps the flat `key = value`
  // form it has always had. Scripts parse this, and a prettier layout for an
  // audience that cannot see it would only be a breaking change.
  if (deps.io.interactive !== true || flags.plain === true) {
    for (const line of renderConfigPlain(config, flags.explain === true)) deps.io.out(line)
    return EXIT.ok
  }
  for (const line of renderConfigList(config, { showAdvanced: flags.explain === true })) {
    deps.io.out(line)
  }
  return EXIT.ok
}

/**
 * One setting, explained in full.
 *
 * The gap this closes: `config show` prints a value and provenance but that is
 * not enough to explain the setting's consequences. Every key already had a
 * careful explanation — in a TypeScript comment, read by everyone except the
 * person who needed it.
 */
export function configExplainCommand(
  deps: CommandDeps,
  key: string,
  flags: { json?: boolean } = {},
): number {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    deps.io.err(`Unknown setting "${key}".`)
    deps.io.err(`Valid settings: ${CONFIG_KEYS.join(', ')}`)
    return EXIT.usage
  }
  const configKey = key as ConfigKey
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const info = configInfo(configKey)
  const entry = config[configKey]

  if (flags.json) {
    deps.io.out(
      JSON.stringify(
        {
          key: configKey,
          label: info.label,
          group: info.group,
          kind: info.kind,
          summary: info.summary,
          detail: info.detail,
          accepts: acceptedValues(configKey),
          ...(info.choices !== undefined ? { choices: info.choices } : {}),
          value: entry.value,
          source: entry.source,
        },
        null,
        2,
      ),
    )
    return EXIT.ok
  }

  if (deps.io.interactive !== true) {
    deps.io.out(`${configKey} = ${JSON.stringify(entry.value)}  [${entry.source}]`)
    deps.io.out(info.detail.replace(/\n\n/g, '\n'))
    deps.io.out(`accepts: ${acceptedValues(configKey)}`)
    return EXIT.ok
  }
  for (const line of renderConfigExplain(configKey, config)) deps.io.out(line)
  return EXIT.ok
}

/**
 * Closest config key by edit distance, or null when nothing is close.
 *
 * The threshold matters more than the algorithm: suggesting a key that shares
 * three letters with the typo sends the reader to the wrong setting with
 * confidence, which is worse than listing all fourteen and letting them look.
 */
function nearestKey(input: string): string | null {
  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of CONFIG_KEYS) {
    const distance = editDistance(input.toLowerCase(), candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(best.length / 3)) ? best : null
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!
    previous[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diagonal = above
    }
  }
  return previous[b.length]!
}

export async function configSetCommand(
  deps: CommandDeps,
  key: string,
  rawValue: string,
  flags: { project?: boolean; local?: boolean; session?: string; yes?: boolean },
): Promise<number> {
  const configKey = configMutationKey(deps, key)
  if (configKey === null) return EXIT.usage
  const info = configInfo(configKey)
  let value: unknown = rawValue
  if (NUMERIC_CONFIG_KEYS.includes(configKey)) {
    const numeric = Number(rawValue)
    if (!Number.isInteger(numeric)) {
      deps.io.err(`${key} takes ${acceptedValues(configKey)}, not "${rawValue}".`)
      return EXIT.usage
    }
    const bounds = configBounds(configKey)
    if (bounds !== undefined && (numeric < bounds.min || numeric > bounds.max)) {
      deps.io.err(`${key} must be between ${bounds.min} and ${bounds.max}.`)
      return EXIT.usage
    }
    value = numeric
  }
  if (BOOLEAN_CONFIG_KEYS.includes(configKey)) {
    if (rawValue !== 'true' && rawValue !== 'false') {
      deps.io.err(`${key} is a toggle — pass "true" or "false", not "${rawValue}".`)
      return EXIT.usage
    }
    value = rawValue === 'true'
  }
  // Sound is listed as an enum of shipped names so the interactive picker has
  // choices, but it also accepts an Account custom name or id. Other enum keys
  // stay closed: an unrecognised value used to be written and only fail at send.
  if (configKey === 'sound') {
    if (!isCliSoundRef(rawValue)) {
      deps.io.err(`${key} takes ${acceptedValues(configKey)} — not "${rawValue}".`)
      return EXIT.usage
    }
  } else if (info.kind === 'enum' && info.choices !== undefined && !info.choices.includes(rawValue)) {
    deps.io.err(`${key} takes one of: ${info.choices.join(', ')} — not "${rawValue}".`)
    return EXIT.usage
  }
  if (info.kind === 'list') value = rawValue.split(',').map((s) => s.trim()).filter(Boolean)
  if (ORIGIN_LIST_CONFIG_KEYS.includes(configKey)) {
    const origins = (value as string[]).map((entry) => normalizeOrigin(entry))
    const rejected = (value as string[]).filter((_, index) => origins[index] === null)
    if (rejected.length > 0) {
      deps.io.err(
        `${key} entries must be bare http(s) origins like "https://host" or "http://host:8080" — not ${rejected.map((entry) => `"${entry}"`).join(', ')}.`,
      )
      return EXIT.usage
    }
    value = origins
  }

  const target = await configMutationTarget(deps, flags)
  if (target === null) return EXIT.usage
  if (target.layer === 'project' && USER_OWNED_CONFIG_KEYS.includes(configKey)) {
    deps.io.err(
      `${key} widens which origins this machine trusts, so it is never read from the repository's shared config — a cloned repository must not be able to set it.`,
    )
    deps.io.err('Store it on this machine (no flag) or for this project personally (--local).')
    return EXIT.usage
  }
  if (target.layer === 'global' && Object.is(value, configDefaultValue(configKey))) {
    deps.io.err(`${key} is already the shipped default (${JSON.stringify(value)}).`)
    deps.io.err(
      `Run \`notifai config unset ${key} --yes\` to remove a redundant override instead of creating one.`,
    )
    return EXIT.usage
  }

  if (!flags.yes) {
    const confirmed = await deps.io.confirm(`Set ${key} = ${JSON.stringify(value)} in ${target.path}?`)
    if (!confirmed) {
      deps.io.err('Not confirmed. Pass --yes to skip the confirmation gate.')
      return EXIT.usage
    }
  }

  const existing = existsSync(target.path)
    ? (parseToml(readFileSync(target.path, 'utf8')) as Record<string, unknown>)
    : {}
  existing[key] = value
  if (target.layer === 'project') mkdirSync(path.dirname(target.path), { recursive: true })
  else ensurePrivateDirectory(path.dirname(target.path))
  writeFileSync(target.path, `${stringifyToml(existing)}\n`)
  deps.io.out(`Wrote ${key} to ${target.path}`)
  return EXIT.ok
}

function configMutationKey(deps: CommandDeps, key: string): ConfigKey | null {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    deps.io.err(`Unknown setting "${key}".`)
    const near = nearestKey(key)
    if (near !== null) deps.io.err(`Did you mean "${near}"?`)
    deps.io.err(`Valid settings: ${CONFIG_KEYS.join(', ')}`)
    deps.io.err('Run `notifai config explain <key>` to see what one of them does.')
    return null
  }
  return key as ConfigKey
}

type ConfigMutationFlags = { project?: boolean; local?: boolean; session?: string; yes?: boolean }
type ConfigMutationLayer = 'global' | 'project' | 'local' | 'session'

async function configMutationTarget(
  deps: CommandDeps,
  flags: ConfigMutationFlags,
): Promise<{ path: string; layer: ConfigMutationLayer } | null> {
  let layer = flags.local ? 'local' : flags.project ? 'project' : 'global'
  if (
    flags.session === undefined &&
    flags.local !== true &&
    flags.project !== true &&
    flags.yes !== true &&
    deps.io.interactive === true &&
    deps.io.select
  ) {
    const selected = await deps.io.select('Where should this setting live?', [
      { value: 'global', label: 'This machine', hint: 'applies across projects' },
      { value: 'project', label: 'This project (shared)', hint: '.notifai/config.toml' },
      { value: 'local', label: 'This project (personal)', hint: 'stored on this machine, not in the repo' },
    ])
    if (selected === null) {
      deps.io.err('No configuration layer selected.')
      return null
    }
    layer = selected
  }

  const targetPath = flags.session
    ? sessionConfigPath(flags.session, deps.env)
    : layer === 'local'
      ? personalProjectConfigPath(deps.cwd, deps.env)
      : layer === 'project'
        ? (findProjectConfigPath(deps.cwd) ?? path.join(deps.cwd, '.notifai', 'config.toml'))
        : globalConfigPath(deps.env)
  return {
    path: targetPath,
    layer: flags.session ? 'session' : (layer as Exclude<ConfigMutationLayer, 'session'>),
  }
}

export async function configUnsetCommand(
  deps: CommandDeps,
  key: string,
  flags: ConfigMutationFlags,
): Promise<number> {
  const configKey = configMutationKey(deps, key)
  if (configKey === null) return EXIT.usage
  const target = await configMutationTarget(deps, flags)
  if (target === null) return EXIT.usage
  const existing = existsSync(target.path)
    ? (parseToml(readFileSync(target.path, 'utf8')) as Record<string, unknown>)
    : {}
  if (!Object.prototype.hasOwnProperty.call(existing, configKey)) {
    deps.io.out(`${configKey} is not set in ${target.path}`)
    return EXIT.ok
  }
  if (!flags.yes) {
    const confirmed = await deps.io.confirm(`Remove ${configKey} from ${target.path}?`)
    if (!confirmed) {
      deps.io.err('Not confirmed. Pass --yes to skip the confirmation gate.')
      return EXIT.usage
    }
  }

  delete existing[configKey]
  if (Object.keys(existing).length === 0) {
    rmSync(target.path, { force: true })
  } else {
    writeFileSync(target.path, `${stringifyToml(existing)}\n`)
  }
  deps.io.out(`Removed ${configKey} from ${target.path}; the inherited value now applies.`)
  return EXIT.ok
}
