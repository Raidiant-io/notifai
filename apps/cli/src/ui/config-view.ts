/**
 * Rendering for the configuration surfaces a person reads.
 *
 * The agent-facing shapes are untouched and live elsewhere: `--json` is the
 * contract, and the flat `key = value` form stays exactly as it was for
 * anything that is not a terminal. What is new is only what a human sees.
 */
import { CONFIG_KEYS, type CliConfig, type ConfigKey } from '../config.js'
import {
  CONFIG_GROUPS,
  acceptedValues,
  configInfo,
  configKeysByGroup,
  describeSource,
  formatValue,
} from '../config-schema.js'
import { glyph, pad, style, terminalWidth, wrap } from './theme.js'

/**
 * The full settings listing, grouped and explained.
 *
 * Each key gets its name (what you type), its value (what is in force), where
 * that value came from, and one line on what it does. The name leads rather
 * than the friendly label because the next thing a reader does with it is type
 * it into `config set`.
 */
export function renderConfigList(
  config: CliConfig,
  options: { showAdvanced?: boolean } = {},
): string[] {
  const columns = terminalWidth()
  const lines: string[] = []
  const nameWidth = Math.max(...CONFIG_KEYS.map((key) => key.length))
  const SUMMARY_INDENT = '      '

  for (const group of CONFIG_GROUPS) {
    const keys = configKeysByGroup(group.id).filter(
      (info) => options.showAdvanced === true || info.advanced !== true,
    )
    if (keys.length === 0) continue

    lines.push('')
    lines.push(style.heading(group.title))
    for (const line of wrap(group.blurb, columns - 2)) lines.push(style.dim(`  ${line}`))
    lines.push('')

    for (const info of keys) {
      const entry = config[info.key]
      const source = describeSource(entry.source)
      const value = formatValue(info.key, entry.value)
      const isSet = source.label !== 'default'
      // The provenance mark is only drawn when there is provenance to show;
      // an empty dim segment still emits escape codes, so a `trimEnd` on the
      // finished string cannot remove it.
      const provenance = isSet ? `  ${style.dim(`${glyph.bullet} ${source.label}`)}` : ''
      lines.push(
        `  ${style.code(pad(info.key, nameWidth))}  ` +
          `${isSet ? style.value(value) : style.unset(value)}${provenance}`,
      )
      for (const line of wrap(info.summary, columns - SUMMARY_INDENT.length)) {
        lines.push(style.dim(`${SUMMARY_INDENT}${line}`))
      }
    }
  }

  lines.push('')
  const command = 'notifai config explain <key>'
  const help = `${glyph.arrow} ${command} for what one of these means and how to change it.`
  for (const line of wrap(help, columns)) {
    lines.push(style.dim(line.replace(command, style.code(command))))
  }
  return lines
}

/**
 * Everything about one key, for someone who has asked about it specifically.
 *
 * This is the payoff of the listing above staying terse: the reader arrives
 * here already knowing which key they care about, so the full paragraph, the
 * legal values, and the layer the current value came from can all be spent on
 * that one key.
 */
export function renderConfigExplain(key: ConfigKey, config: CliConfig): string[] {
  const info = configInfo(key)
  const entry = config[key]
  const source = describeSource(entry.source)
  const columns = terminalWidth()
  const lines: string[] = []

  lines.push('')
  lines.push(`${style.code(key)}  ${style.dim(glyph.bullet)}  ${style.heading(info.label)}`)
  lines.push('')

  for (const paragraph of info.detail.split('\n\n')) {
    for (const line of wrap(paragraph, columns - 2)) lines.push(`  ${line}`)
    lines.push('')
  }

  const valueLabel = formatValue(key, entry.value)
  lines.push(
    `  ${style.dim(pad('Now', 10))}${style.value(valueLabel)}  ${style.dim(`${glyph.bullet} ${source.label}`)}`,
  )
  if (source.path !== null) lines.push(`  ${style.dim(pad('', 10))}${style.dim(source.path)}`)
  lines.push(`  ${style.dim(pad('Accepts', 10))}${acceptedValues(key)}`)

  if (info.choices !== undefined && info.choiceHints !== undefined) {
    lines.push('')
    for (const choice of info.choices) {
      const hint = info.choiceHints[choice]
      lines.push(
        `  ${style.dim(pad('', 10))}${style.code(pad(choice, 14))}${style.dim(hint ?? '')}`.trimEnd(),
      )
    }
  }

  lines.push('')
  const example = info.example ?? (info.choices?.[0] ?? 'value')
  lines.push(`  ${style.dim('Change it')} ${style.code(`notifai config set ${key} ${example}`)}`)
  if (entry.source !== 'default' && entry.source !== 'flag') {
    lines.push(`  ${style.dim('Inherit it')} ${style.code(`notifai config unset ${key}`)}`)
  }
  lines.push('')
  return lines
}

/** The flat form, unchanged, for anything that is not a person at a terminal. */
export function renderConfigPlain(config: CliConfig, explain: boolean): string[] {
  return CONFIG_KEYS.map((key) => {
    const entry = config[key]
    const provenance = explain ? `  [${entry.source}]` : ''
    return `${key} = ${JSON.stringify(entry.value)}${provenance}`
  })
}
