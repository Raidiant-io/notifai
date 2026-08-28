import { describe, expect, it } from 'vitest'
import { SOUND_NAME_MAX_LENGTH, SOUND_REF_MAX_LENGTH } from '@raidiant/notifai-protocol'
import { isCliSoundRef, unknownSoundMessage } from './sound-ref.js'

describe('isCliSoundRef', () => {
  it('accepts shipped names and the silent spelling', () => {
    for (const ref of ['default', 'done', 'attention', 'alert', 'none']) {
      expect(isCliSoundRef(ref), ref).toBe(true)
    }
  })

  it('accepts an Account custom sound id and a display name', () => {
    expect(isCliSoundRef('snd_01HQTEST')).toBe(true)
    expect(isCliSoundRef('Kitchen timer')).toBe(true)
    expect(isCliSoundRef('airhorn')).toBe(true)
  })

  it('rejects empty, blank, and over-long values', () => {
    expect(isCliSoundRef('')).toBe(false)
    expect(isCliSoundRef('   ')).toBe(false)
    expect(isCliSoundRef('n'.repeat(SOUND_NAME_MAX_LENGTH + 1))).toBe(false)
    expect(isCliSoundRef(`snd_${'a'.repeat(SOUND_REF_MAX_LENGTH)}`)).toBe(false)
  })
})

describe('unknownSoundMessage', () => {
  it('points at the list command rather than only the shipped set', () => {
    expect(unknownSoundMessage('nope')).toContain('notifai sounds')
    expect(unknownSoundMessage('nope')).toContain('custom sound')
  })
})
