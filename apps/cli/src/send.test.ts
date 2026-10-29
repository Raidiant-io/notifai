import { describe,expect,it } from 'vitest'
import { parseChoices } from './send.js'
import { buildQuestions } from './commands-ask.js'
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


it.each([['はい', 'いいえ'], ['C++', 'C#'], ['C++', 'C#', 'c-2'], ['!!!', 'option-1']])(
  'gives distinct stable IDs to exact ask choices %j', (...labels) => {
    const parsed = parseChoices(labels)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.choices!.map(choice => choice.label)).toEqual(labels)
    expect(new Set(parsed.choices!.map(choice => choice.id)).size).toBe(labels.length)
    expect(parseChoices(labels)).toEqual(parsed)
    expect(buildQuestions({ choice: labels, title: 'Choice' }, 'Which?').ok).toBe(true)
  },
)

it('retains existing unambiguous ask IDs and rejects genuinely duplicate labels', () => {
  expect(parseChoices(['Staging', 'Production'])).toMatchObject({ choices: [{ id: 'staging' }, { id: 'production' }] })
  expect(parseChoices(['Same', 'Same']).ok).toBe(false)
})

describe('form question titles and details', () => {
  const ask = (questions: unknown[]) =>
    buildQuestions({ form: JSON.stringify({ title: 'Release plan', summary: 'Two decisions.', questions }) }, undefined)

  it('carries each question title and its Markdown detail to the devices', () => {
    const built = ask([
      { title: 'Ship day', text: 'Ship on Friday?', detail: '  Friday has **no** on-call cover.\n\nMonday is safe.  ', choices: ['Yes', 'No'] },
      { title: 'Release notes', text: 'Anything to add?' },
    ])
    expect(built).toMatchObject({ ok: true, headers: ['Ship day', 'Release notes'] })
    if (!built.ok) return
    expect(built.notes).toBeUndefined()
    expect(built.questions[0]).toMatchObject({ title: 'Ship day', text: 'Ship on Friday?', detail: 'Friday has **no** on-call cover.\n\nMonday is safe.' })
    expect(built.questions[1]).toEqual({ id: expect.any(String), title: 'Release notes', text: 'Anything to add?' })
  })

  it('names one question by the form title alone, keeping its detail', () => {
    const built = ask([{ title: 'Ship day', text: 'Ship on Friday?', detail: 'Why it matters.' }])
    expect(built.ok && built.questions[0]).toEqual({ id: expect.any(String), text: 'Ship on Friday?', detail: 'Why it matters.' })
  })

  it('refuses a detail that is too long, empty, not text or holds an image, saying where the rest goes', () => {
    expect(ask([{ text: 'A?', detail: 'x'.repeat(501) }, { text: 'B?' }])).toEqual({ ok: false, error: expect.stringMatching(/^Question 1: "detail" is 501 characters; keep it within 500.*form "body"/) })
    expect(ask([{ text: 'A?', detail: '🚀'.repeat(500) }]).ok).toBe(true)
    expect(ask([{ text: 'A?', detail: '  ' }])).toMatchObject({ ok: false, error: expect.stringContaining('cannot be empty') })
    expect(ask([{ text: 'A?', detail: 3 }])).toMatchObject({ ok: false, error: expect.stringContaining('must be a Markdown string') })
    expect(ask([{ text: 'A?', detail: 'See ![chart](media:1)' }])).toMatchObject({ ok: false, error: expect.stringContaining('cannot hold images') })
  })

  it('keeps an older form with a long title working: the terminal header stays, devices leave it out with a note', () => {
    const long = 'A title far longer than a word or two, as older forms wrote'
    const built = ask([{ title: long, text: 'A?' }, { title: 'Short', text: 'B?' }])
    expect(built).toMatchObject({ ok: true, headers: [long, 'Short'] })
    if (!built.ok) return
    expect(built.questions[0]!.title).toBeUndefined()
    expect(built.questions[1]!.title).toBe('Short')
    expect(built.notes).toEqual([expect.stringContaining('devices leave out the title of question 1')])
  })
})
