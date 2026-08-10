/**
 * The wordmark shown when a human opens the interactive app.
 *
 * Three tiers, chosen by what the terminal can actually render rather than by
 * what looks best in a screenshot: box-drawing blocks when the terminal is wide
 * and Unicode-capable, a pure-ASCII form that survives anywhere, and a plain
 * word when neither fits. A banner that wraps is worse than no banner, so the
 * width check is not optional.
 *
 * The art is embedded rather than rendered at run time. It is one fixed word
 * that will never change, and shipping a font engine to redraw a constant on
 * every launch would cost every install — including the agents that never see
 * it — for no benefit.
 */
import { gradientBlock, style, terminalWidth, unicode } from './theme.js'

/** ANSI Shadow. 50 columns, 6 rows. */
const BLOCK = [
  '███╗   ██╗ ██████╗ ████████╗██╗███████╗ █████╗ ██╗',
  '████╗  ██║██╔═══██╗╚══██╔══╝██║██╔════╝██╔══██╗██║',
  '██╔██╗ ██║██║   ██║   ██║   ██║█████╗  ███████║██║',
  '██║╚██╗██║██║   ██║   ██║   ██║██╔══╝  ██╔══██║██║',
  '██║ ╚████║╚██████╔╝   ██║   ██║██║     ██║  ██║██║',
  '╚═╝  ╚═══╝ ╚═════╝    ╚═╝   ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝',
]

/** Pure ASCII. 34 columns, 4 rows — safe on any terminal, any code page. */
const ASCII = [
  '  _  _  ___ _____ ___ ___ _   ___ ',
  ' | \\| |/ _ \\_   _|_ _| __/_\\ |_ _|',
  ' | .` | (_) || |  | || _/ _ \\ | | ',
  ' |_|\\_|\\___/ |_| |___|_/_/ \\_\\___|',
]

export type BannerSize = 'block' | 'ascii' | 'word'

export function bannerSize(columns = terminalWidth()): BannerSize {
  if (unicode && columns >= 54) return 'block'
  if (columns >= 38) return 'ascii'
  return 'word'
}

/** The wordmark as rendered lines, gradient included. */
export function bannerLines(columns = terminalWidth()): string[] {
  switch (bannerSize(columns)) {
    case 'block':
      return gradientBlock(BLOCK)
    case 'ascii':
      return gradientBlock(ASCII)
    case 'word':
      return gradientBlock(['N O T I F A I'])
  }
}

/**
 * Reveal the wordmark one row at a time.
 *
 * Deliberately brief and deliberately skippable: this runs before someone can
 * do anything, so it may not become a wait. It is skipped entirely when output
 * is not a TTY, when `NOTIFAI_NO_ANIMATION` is set, and under `CI`.
 */
export async function printBanner(
  options: { animate?: boolean; env?: NodeJS.ProcessEnv; write?: (line: string) => void } = {},
): Promise<void> {
  const env = options.env ?? process.env
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const lines = bannerLines()
  const animate =
    options.animate !== false &&
    process.stdout.isTTY === true &&
    (env['NOTIFAI_NO_ANIMATION'] ?? '') === '' &&
    (env['CI'] ?? '') === ''

  write('')
  for (const line of lines) {
    // Two columns, matching the tagline and the status card beneath it. Flush
    // left, the wordmark reads as a separate thing sitting above the app.
    write(`  ${line}`)
    if (animate) await new Promise((resolve) => setTimeout(resolve, 26))
  }
  write('')
}

/**
 * One line of orientation under the wordmark — and it must stay one line.
 * Wrapped onto two it stops reading as a subtitle and starts reading as the
 * first paragraph of something, so a narrow terminal gets the version alone.
 */
export function tagline(version: string, columns = terminalWidth()): string {
  const full = 'Native notifications for agents and local programs'
  // Two leading columns of indent, two trailing for the version.
  return columns >= full.length + 12
    ? `${style.dim(full)}  ${style.dim(`v${version}`)}`
    : style.dim(`v${version}`)
}
