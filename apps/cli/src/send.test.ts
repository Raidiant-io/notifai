import { describe,expect,it } from 'vitest'
import {
BODY_NOTE_LENGTH,
SUMMARY_NOTE_LENGTH,
accidentalEscapedNewlineMessage,
contentLengthNotes,
hasAccidentalEscapedNewlines,
rejectAccidentalEscapedNewlines,
rewriteMediaReferences,
} from './send.js'

describe('Body image references', () => {
  it.each(['attachment:1', 'file:///tmp/result.png', './result.png', 'https://images.example/result(a(b)).png', 'http://images.example/result.png', 'data:image/png;base64,AA'])('rejects an unresolvable image target %s', (target) => {
    expect(rewriteMediaReferences(`![Result](${target})`, ['med_attached'])).toMatchObject({
      ok: false,
      error: expect.stringContaining(target),
    })
    expect(rewriteMediaReferences(`![Result](${target})`, ['med_attached'])).toMatchObject({
      error: expect.stringContaining('media:1'),
    })
  })

  it('preserves ordinary remote links and escaped image syntax', () => {
    const body = '[Result](https://images.example/result.png) and \\![literal](attachment:1)'
    expect(rewriteMediaReferences(body, [])).toEqual({ ok: true, body })
  })
})

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

  it('does not treat an escaped backslash plus n as accidental', () => {
    expect(hasAccidentalEscapedNewlines('escape as \\\\n')).toBe(false)
  })
})

describe('content length notes', () => {
  it('notes only a long Summary or Body, counting Unicode characters', () => {
    expect(contentLengthNotes('Login works again.', 'Short.')).toEqual([])
    expect(contentLengthNotes('é'.repeat(SUMMARY_NOTE_LENGTH - 1), 'x'.repeat(BODY_NOTE_LENGTH))).toEqual([])
    const notes = contentLengthNotes('é'.repeat(SUMMARY_NOTE_LENGTH), 'x'.repeat(BODY_NOTE_LENGTH + 1))
    expect(notes).toHaveLength(2)
    expect(notes[0]).toContain(`Summary is ${SUMMARY_NOTE_LENGTH} characters`)
    expect(notes[1]).toContain(`Body is ${BODY_NOTE_LENGTH + 1} characters`)
  })
})
