/**
 * One visual language for every human-facing surface: help, `config show`,
 * `doctor`, and the interactive app.
 *
 * Two rules hold everything here together.
 *
 * Colour is decoration, never information. Every state that colour marks also
 * carries a glyph and a word, because the output is read through pipes, on
 * monochrome terminals, by screen readers, and by people who cannot separate
 * red from green. `picocolors` resolves to identity functions when stdout is
 * not a TTY or `NO_COLOR` is set, so the plain path is the same code, not a
 * second implementation that can drift.
 *
 * And an agent's bytes are not ours to restyle. Machine-readable output
 * (`--json`) never routes through this module, and every non-TTY invocation
 * lands on the uncoloured branch by construction.
 */
import pc from 'picocolors'

/** True when the terminal can render the box-drawing and status glyphs below. */
export const unicode: boolean =
  process.platform !== 'win32' ||
  process.env['WT_SESSION'] !== undefined ||
  process.env['TERM_PROGRAM'] === 'vscode' ||
  process.env['ConEmuTask'] === '{cmd::Cmder}'

/** True when 24-bit colour is available, which the banner gradient needs. */
export function supportsTrueColor(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!pc.isColorSupported) return false
  const colorterm = env['COLORTERM'] ?? ''
  if (/^(truecolor|24bit)$/i.test(colorterm)) return true
  return env['TERM_PROGRAM'] === 'iTerm.app' || env['TERM_PROGRAM'] === 'vscode'
}

export const color = pc

/**
 * Brand ramp, shared with the companion app icon: pink → coral → rose →
 * magenta. Used for the wordmark and for accenting the surfaces a human sees.
 */
export const BRAND_RAMP = ['#FF9EC0', '#FF816B', '#EC5A73', '#B84E93'] as const

interface Rgb {
  r: number
  g: number
  b: number
}

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  }
}

/**
 * Sample the brand ramp at `t` in [0, 1]. Multi-stop so the gradient keeps the
 * icon's coral midtones instead of washing straight from pink to magenta.
 */
export function rampAt(t: number, ramp: readonly string[] = BRAND_RAMP): string {
  const clamped = Math.min(1, Math.max(0, t))
  const span = ramp.length - 1
  const scaled = clamped * span
  const index = Math.min(span - 1, Math.floor(scaled))
  const { r, g, b } = mix(hexToRgb(ramp[index]!), hexToRgb(ramp[index + 1]!), scaled - index)
  return `[38;2;${r};${g};${b}m`
}

const RESET = '[39m'

/**
 * SGR escape sequences, in the three shapes the helpers below need: stripping
 * them to measure, splitting around them to slice, and recognising one on its
 * own. Kept together so a change to what counts as an escape lands once.
 */
const ANSI_GLOBAL = /\[[0-9;]*m/g
const ANSI_SPLIT = /(\[[0-9;]*m)/
const ANSI_ONLY = /^\[[0-9;]*m$/

/**
 * Paint `text` across the brand ramp, one escape per character.
 *
 * Falls back to a single flat brand colour without truecolor, and to the bare
 * string with colour off — a gradient is the most decorative thing this CLI
 * does, so it must also be the first thing to degrade quietly.
 */
export function gradient(text: string, ramp: readonly string[] = BRAND_RAMP): string {
  if (!pc.isColorSupported) return text
  if (!supportsTrueColor()) return pc.magenta(text)
  const chars = [...text]
  const last = Math.max(1, chars.length - 1)
  return chars.map((char, i) => (char === ' ' ? char : `${rampAt(i / last, ramp)}${char}`)).join('') + RESET
}

/**
 * Paint each line of a block so the gradient runs left-to-right across the
 * whole block rather than restarting per line. The wordmark is one image, and
 * per-line gradients make it read as several.
 */
export function gradientBlock(lines: readonly string[], ramp: readonly string[] = BRAND_RAMP): string[] {
  if (!pc.isColorSupported) return [...lines]
  const width = Math.max(1, ...lines.map((line) => [...line].length))
  if (!supportsTrueColor()) return lines.map((line) => pc.magenta(line))
  return lines.map((line) =>
    [...line]
      .map((char, i) => (char === ' ' ? char : `${rampAt(i / Math.max(1, width - 1), ramp)}${char}`))
      .join('') + RESET,
  )
}

// ---------------------------------------------------------------------------
// Semantic styles
// ---------------------------------------------------------------------------

export const style = {
  /** A heading that opens a section. */
  heading: (text: string): string => pc.bold(text),
  /** The brand voice — command names, the product name, the selected thing. */
  accent: (text: string): string => pc.magenta(text),
  /** Secondary text: hints, provenance, units, defaults. */
  dim: (text: string): string => pc.dim(text),
  /** Something the reader can type. */
  code: (text: string): string => pc.cyan(text),
  ok: (text: string): string => pc.green(text),
  warn: (text: string): string => pc.yellow(text),
  bad: (text: string): string => pc.red(text),
  /** A value as it currently stands. */
  value: (text: string): string => pc.bold(pc.white(text)),
  /** A value that is not set, or is inherited rather than chosen. */
  unset: (text: string): string => pc.dim(pc.italic(text)),
} as const

/**
 * Status marks. The glyph and the colour say the same thing twice on purpose;
 * either alone is enough to read the line.
 */
export const glyph = {
  ok: unicode ? '●' : '*',
  warn: unicode ? '▲' : '!',
  bad: unicode ? '✕' : 'x',
  pending: unicode ? '○' : 'o',
  bullet: unicode ? '•' : '-',
  arrow: unicode ? '→' : '->',
  chevron: unicode ? '›' : '>',
  bar: unicode ? '│' : '|',
} as const

export type Tone = 'ok' | 'warn' | 'bad' | 'pending'

/** A coloured glyph for a tone; the caller supplies the words. */
export function mark(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return style.ok(glyph.ok)
    case 'warn':
      return style.warn(glyph.warn)
    case 'bad':
      return style.bad(glyph.bad)
    case 'pending':
      return style.dim(glyph.pending)
  }
}

/** Visible width, ignoring ANSI escapes, for alignment maths. */
export function width(text: string): number {
  return [...text.replace(ANSI_GLOBAL, '')].length
}

/** Pad to `size` using visible width, so colour never breaks a column. */
export function pad(text: string, size: number): string {
  return text + ' '.repeat(Math.max(0, size - width(text)))
}

/**
 * Usable terminal width: the real one, capped so paragraphs do not run to 200
 * characters on a maximised window.
 *
 * No lower clamp. Raising a narrow terminal to a comfortable minimum sounds
 * harmless and is not — every box drawn to that invented width overflows the
 * real one and wraps, which looks far worse than a cramped box that fits.
 */
export function terminalWidth(fallback = 80): number {
  const columns = process.stdout.columns
  if (typeof columns !== 'number' || columns <= 0) return fallback
  return Math.min(100, columns)
}

/**
 * A titled box around `rows`.
 *
 * Hand-drawn rather than delegated, because the obvious library call sizes
 * itself from `process.stdout.columns` and divides by it — a pty that reports
 * zero columns (some CI runners, some `script` invocations) makes the padding
 * negative and throws, taking the whole screen down with it. A status card is
 * decoration; it may degrade, but it must never be what crashes the app.
 *
 * Rows are measured with `width`, so colour inside them does not skew the
 * border, and anything too wide for the terminal is clipped rather than
 * wrapped — a status line that wraps stops being a status line.
 */
export function card(title: string, rows: readonly string[], columns = terminalWidth()): string[] {
  const [tl, tr, bl, br, h, v] = unicode
    ? ['╭', '╮', '╰', '╯', '─', '│']
    : ['+', '+', '+', '+', '-', '|']
  const inner = Math.max(20, columns - 4)
  const content = rows.map((row) => (width(row) > inner ? clip(row, inner) : row))
  const bodyWidth = Math.max(width(title) + 4, ...content.map((row) => width(row)))
  const boxWidth = Math.min(inner, bodyWidth)
  const heading = `${h} ${style.heading(title)} `
  const lines: string[] = []
  lines.push(style.dim(tl) + heading + style.dim(h!.repeat(Math.max(0, boxWidth - width(heading) + 2))) + style.dim(tr))
  for (const row of content) {
    lines.push(`${style.dim(v)} ${pad(row, boxWidth)} ${style.dim(v)}`)
  }
  lines.push(style.dim(bl! + h!.repeat(boxWidth + 2) + br))
  return lines
}

/**
 * Truncate to a visible width, carrying escape sequences through untouched.
 *
 * Counting only printable characters is the whole point: slicing a coloured
 * string by `String.length` cuts through an escape sequence and spills raw
 * `[38;2` into the terminal.
 */
export function clip(text: string, limit: number): string {
  if (width(text) <= limit) return text
  const parts = text.split(ANSI_SPLIT)
  let out = ''
  let visible = 0
  for (const part of parts) {
    if (part === undefined || part === '') continue
    if (ANSI_ONLY.test(part)) {
      out += part
      continue
    }
    for (const char of part) {
      if (visible >= limit - 1) return `${out}\u2026${RESET}`
      out += char
      visible += 1
    }
  }
  return `${out}${RESET}`
}

/**
 * Wrap `text` to `columns`, returning bare lines.
 *
 * Indentation is the caller's, deliberately: an earlier version indented
 * continuation lines itself, callers indented every line as well, and each
 * wrapped paragraph stepped further right down the page.
 */
export function wrap(text: string, columns: number): string[] {
  // Honour the width asked for. A floor here would silently ignore small
  // values and hand back lines wider than the caller reserved room for; a
  // width of zero or less is the only nonsense, and that falls back.
  const limit = columns > 0 ? columns : 80
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (width(candidate) > limit && line !== '') {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line !== '') lines.push(line)
  return lines
}
