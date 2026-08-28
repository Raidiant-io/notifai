import {
  CLI_SOUNDS,
  SOUND_NAME_MAX_LENGTH,
  SOUND_REF_MAX_LENGTH,
  isCustomSoundId,
} from '@raidiant/notifai-protocol'

/**
 * What `--sound` and the saved `sound` key accept: shipped semantic names,
 * the CLI silent spelling, an Account custom sound id, or a custom display name.
 */
export function isCliSoundRef(value: string): boolean {
  if ((CLI_SOUNDS as readonly string[]).includes(value)) return true
  if (value.length < 1 || value.length > SOUND_REF_MAX_LENGTH) return false
  if (isCustomSoundId(value)) return true
  const trimmed = value.trim()
  return trimmed.length >= 1 && trimmed.length <= SOUND_NAME_MAX_LENGTH
}

export function unknownSoundMessage(sound: string): string {
  return (
    `Unknown sound "${sound}" — use a shipped name (${CLI_SOUNDS.join(', ')}), ` +
    'a custom sound id, or a custom sound name. Run `notifai sounds` to list what this Account can play.'
  )
}

/** Shipped names plus the CLI silent spelling, with User-facing labels. */
export const SHIPPED_SOUND_LISTING = [
  { ref: 'default', name: 'Device default' },
  { ref: 'done', name: 'completion chime' },
  { ref: 'attention', name: 'attention tone' },
  { ref: 'alert', name: 'most insistent tone' },
  { ref: 'none', name: 'silent' },
] as const
