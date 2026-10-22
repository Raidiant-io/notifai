import type { QuestionT } from '@raidiant/notifai-protocol'
import { describe, expect, it } from 'vitest'
import { PICKER_HEADER_MAX, handBackInput, pickerCanAsk, pickerHeader, pickerSource, sameAsHandBack } from './claude-picker-handback.js'

const closed = (text: string, count = 2): QuestionT => ({
  id: text.toLowerCase().replace(/\W+/gu, '-'), text,
  choices: Array.from({ length: count }, (_, index) => ({ id: `c${index}`, label: `Choice ${index}` })),
})

describe('the handed-back picker', () => {
  it('keeps a title that fits as the header and cuts a longer one at a word, never the device title', () => {
    expect(pickerHeader('Release branch for the payments migration')).toBe('Release branch for the payments migration')
    const long = 'Which release branch should carry the payments migration this week'
    const header = pickerHeader(long)
    expect(header).toBe('Which release branch should carry the...')
    expect(header.length).toBeLessThanOrEqual(PICKER_HEADER_MAX)
    expect(pickerHeader('x'.repeat(60))).toBe(`${'x'.repeat(PICKER_HEADER_MAX - 3)}...`)
    const pending = { question_id: 'q_1', title: long, questions: [closed('Which branch?')] }
    expect(handBackInput(pending)!.questions[0]!.header).toBe(header)
    expect(pending.title).toBe(long)
  })

  it('asks only what the picker can ask exactly: one to four questions of two to four choices', () => {
    expect(pickerCanAsk([closed('A?')])).toBe(true)
    expect(pickerCanAsk([closed('A?'), closed('B?'), closed('C?'), closed('D?')])).toBe(true)
    expect(pickerCanAsk([closed('A?'), closed('B?'), closed('C?'), closed('D?'), closed('E?')])).toBe(false)
    expect(pickerCanAsk([closed('A?', 5)])).toBe(false)
    expect(pickerCanAsk([{ id: 'a', text: 'A?' }])).toBe(false)
    // The picker keys its answers by question text, so two equal texts cannot both come back.
    expect(pickerCanAsk([closed('A?'), { ...closed('A?'), id: 'other' }])).toBe(false)
  })

  it('heads several questions with their own titles, and needs one for each', () => {
    const questions = [closed('Which branch?'), closed('Which checks?')]
    expect(handBackInput({ question_id: 'q_1', title: 'Release', headers: ['Branch', 'Checks'], questions })!.questions.map(entry => entry.header))
      .toEqual(['Branch', 'Checks'])
    expect(handBackInput({ question_id: 'q_1', title: 'Release', questions })).toBeNull()
  })

  it('reads the registration a picker names, and compares it by its questions alone', () => {
    const input = handBackInput({ question_id: 'q_1', title: 'Release', questions: [closed('Which branch?')] })!
    expect(pickerSource(input)).toBe('q_1')
    expect(pickerSource({ ...input, metadata: { source: 'elsewhere:q_1' } })).toBeUndefined()
    expect(pickerSource({ questions: input.questions })).toBeUndefined()
    const asked = input.questions.map(entry => ({ ...entry, header: 'Other', options: entry.options.map(option => ({ ...option, description: 'x' })) }))
    expect(sameAsHandBack(asked, input)).toBe(true)
    expect(sameAsHandBack(asked.map(entry => ({ ...entry, multiSelect: true })), input)).toBe(false)
    expect(sameAsHandBack(asked.map(entry => ({ ...entry, options: [...entry.options].reverse() })), input)).toBe(false)
  })
})
