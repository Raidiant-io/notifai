import { describe, expect, it } from 'vitest'
import {
  accidentalEscapedNewlineMessage,
  hasAccidentalEscapedNewlines,
  rejectAccidentalEscapedNewlines,
} from './send.js'

describe('accidental escaped newlines', () => {
  it('catches a shell-quoted backslash-n body', () => {
    expect(hasAccidentalEscapedNewlines('line1\\nline2')).toBe(true)
    expect(rejectAccidentalEscapedNewlines('line1\\nline2', false)).toBe(
      accidentalEscapedNewlineMessage(),
    )
  })

  it('preserves real multiline Markdown', () => {
    expect(hasAccidentalEscapedNewlines('line1\nline2')).toBe(false)
    expect(rejectAccidentalEscapedNewlines('line1\nline2', false)).toBeNull()
  })

  it('lets an explicit flag keep visible backslash-n text', () => {
    expect(rejectAccidentalEscapedNewlines('use \\n in the sample', true)).toBeNull()
  })

  it('does not treat an escaped backslash plus n as accidental', () => {
    expect(hasAccidentalEscapedNewlines('escape as \\\\n')).toBe(false)
  })
})
