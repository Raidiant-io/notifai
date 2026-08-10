import { describe, expect, it } from 'vitest'
import { card, clip, pad, width, wrap } from './theme.js'

/**
 * These run with colour off — vitest's stdout is not a TTY, so `picocolors`
 * resolves to identity functions. That is the interesting case: it is the one
 * every agent, pipe and CI log gets, and the one where a layout bug is
 * invisible to a human developer reading a colourful terminal.
 */

const RED = '[31m'
const RESET = '[39m'

describe('width', () => {
  it('counts printable characters, not escape bytes', () => {
    expect(width('hello')).toBe(5)
    expect(width(`${RED}hello${RESET}`)).toBe(5)
  })
})

describe('pad', () => {
  it('pads by visible width so colour cannot break a column', () => {
    expect(width(pad(`${RED}ab${RESET}`, 6))).toBe(6)
    expect(pad('ab', 4)).toBe('ab  ')
  })

  it('never truncates when the text already exceeds the column', () => {
    expect(pad('abcdef', 3)).toBe('abcdef')
  })
})

describe('wrap', () => {
  it('breaks on whitespace within the limit', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  })

  it('returns bare lines, leaving indentation to the caller', () => {
    // The regression this guards: wrap used to indent continuation lines
    // itself while callers indented every line, so each wrapped paragraph
    // stepped further right down the page.
    for (const line of wrap('alpha beta gamma delta', 11)) {
      expect(line.startsWith(' ')).toBe(false)
    }
  })

  it('keeps a word that is longer than the limit rather than losing it', () => {
    expect(wrap('supercalifragilistic', 5)).toEqual(['supercalifragilistic'])
  })
})

describe('clip', () => {
  it('leaves text that already fits', () => {
    expect(clip('short', 10)).toBe('short')
  })

  it('truncates by visible width and never mid-escape', () => {
    const clipped = clip(`${RED}abcdefghij${RESET}`, 5)
    expect(width(clipped)).toBeLessThanOrEqual(5)
    // A slice by String.length would cut through `[31m` and spill the
    // raw bytes into the terminal.
    expect(clipped).toContain(RED)
    expect(clipped.endsWith(RESET)).toBe(true)
  })
})

describe('card', () => {
  it('draws a closed box whose rows all share one width', () => {
    const lines = card('Status', ['a', 'bbbbbbbbbb'], 40)
    const widths = new Set(lines.map((line) => width(line)))
    expect(widths.size).toBe(1)
    expect(lines[0]).toContain('Status')
  })

  it('measures rows by visible width, so colour does not skew the border', () => {
    const plain = card('T', ['abcdef'], 40)
    const coloured = card('T', [`${RED}abcdef${RESET}`], 40)
    expect(plain.map(width)).toEqual(coloured.map(width))
  })

  it('survives a terminal that reports no usable width', () => {
    // A pty reporting zero columns made the obvious library call compute a
    // negative pad and throw, taking the whole interactive app with it. A
    // status card may degrade; it must never be the thing that crashes.
    expect(() => card('Status', ['something reasonably long here'], 0)).not.toThrow()
    expect(card('Status', ['x'], 0).length).toBe(3)
  })

  it('clips a row too wide for the terminal instead of wrapping it', () => {
    const lines = card('T', ['x'.repeat(200)], 40)
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(40)
  })
})
