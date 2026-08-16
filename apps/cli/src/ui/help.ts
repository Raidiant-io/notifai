/**
 * Help that answers "what can I do here", not "what strings does argv accept".
 *
 * The old help listed seventeen commands in one flat column, with the two a new
 * user needs (`init`, `login`) sitting between a platform capability dump and
 * an entry point marked "Internal:". Everything was equally prominent, which is
 * the same as nothing being prominent.
 *
 * Grouping and colour are Commander's own (`commandsGroup`, `optionsGroup`, and
 * the `styleX` hooks it calls when the output has colours); this module only
 * supplies the palette and the group vocabulary. Commander turns its styling
 * off by itself when the output is not a terminal, so piped help stays plain
 * without a second code path.
 */
import { Help, type Command, type HelpConfiguration, type Option } from 'commander'
import { glyph, style } from './theme.js'

/**
 * Group headings, in the order a reader meets them.
 *
 * Ordering is by who needs it and when: first run, then daily use, then the
 * commands agents drive, then the things touched once or never. Commander
 * renders groups in first-use order, so these constants are also the layout.
 */
export const GROUP = {
  start: 'Getting started:',
  daily: 'Everyday:',
  agent: 'For agents and scripts:',
  advanced: 'Account and wiring:',
  help: 'Help:',
} as const

/** Option groups for `send`, which carries thirty flags. */
export const SEND_GROUP = {
  content: 'What it says:',
  routing: 'Where it goes:',
  presentation: 'How it arrives:',
  reply: 'Asking for an answer:',
  advanced: 'Advanced:',
} as const

/** Group order, independent of the order commands happen to be registered in. */
const GROUP_ORDER: readonly string[] = [
  GROUP.start,
  GROUP.daily,
  GROUP.agent,
  GROUP.advanced,
  GROUP.help,
]

function groupRank(heading: string): number {
  const index = GROUP_ORDER.indexOf(heading)
  // Anything not named above keeps its position relative to its peers, because
  // the sort is stable — which is what lets the same override run over option
  // groups without needing to know their headings.
  return index === -1 ? GROUP_ORDER.length : index
}

export const helpConfiguration: HelpConfiguration = {
  // Groups already carry the intended order; alphabetising would scatter the
  // dependency between `login` and everything that needs a credential.
  sortSubcommands: false,
  sortOptions: false,
  showGlobalOptions: false,

  /**
   * Commander seeds group order from the raw registration order, which ties
   * how the help reads to where a `program.command(…)` block happens to sit in
   * the file — move one and the help silently reorders. Sorting the finished
   * grouping makes `GROUP_ORDER` the single place that decision is made.
   *
   * The same override runs over option groups, whose headings are not in
   * `GROUP_ORDER` at all. They all rank equal, and `sort` is stable, so they
   * keep the order they were declared in.
   */
  groupItems<T extends Command | Option>(
    this: Help,
    unsortedItems: T[],
    visibleItems: T[],
    getGroup: (item: T) => string,
  ): Map<string, T[]> {
    // `.call` cannot carry the method's own generic through, so the signature
    // is restated once here instead of widening every caller to
    // `Command | Option`.
    const base = Help.prototype.groupItems as unknown as (
      this: Help,
      unsorted: T[],
      visible: T[],
      group: (item: T) => string,
    ) => Map<string, T[]>
    const grouped = base.call(this, unsortedItems, visibleItems, getGroup)
    return new Map([...grouped.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0])))
  },

  styleTitle: (title: string): string => style.heading(title),
  styleCommandText: (text: string): string => style.accent(text),
  styleSubcommandTerm: (text: string): string => style.code(text),
  styleOptionTerm: (text: string): string => style.code(text),
  styleArgumentTerm: (text: string): string => style.code(text),
  styleDescriptionText: (text: string): string => text,
  styleUsage: (text: string): string => text,
}

/**
 * Footer for the root help.
 *
 * Its whole job is to make the interactive app discoverable, because someone
 * reading a wall of flags has already demonstrated they did not know it was
 * there.
 */
export function rootHelpFooter(): string {
  const lines = [
    '',
    style.heading('Start here'),
    `  ${style.code('notifai')}              ${style.dim(
      `${glyph.arrow} the interactive app: status, settings, devices, test sends`,
    )}`,
    `  ${style.code('notifai init')}         ${style.dim(`${glyph.arrow} set this project up, step by step`)}`,
    '',
    style.heading('First call, for an agent'),
    `  ${style.code('notifai send --kind done --title "All 42 tests passed" --body "Finished in 3m 10s. Next: review the release candidate."')}`,
    `  ${style.code('notifai ask "Deploy migration 0007 to production?" --choice Deploy --choice Hold')}`,
    `  ${style.dim(`${glyph.arrow} ${style.code('ask')} needs question routing installed; ${style.code('notifai doctor --json')} says whether it is.`)}`,
    '',
    style.dim(
      `Every command takes ${style.code('--help')}. Where a command has machine-readable output it takes ${style.code('--json')}.`,
    ),
    style.dim(`Settings are explained by ${style.code('notifai config show')} and ${style.code('notifai config explain <key>')}.`),
  ]
  return lines.join('\n')
}
