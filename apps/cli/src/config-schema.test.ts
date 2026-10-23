import { describe,expect,it } from 'vitest'
import {
acceptedValues,
configInfo,
describeSource,
formatDuration,
formatValue
} from './config-schema.js'
import {
CONFIG_KEYS,
configBounds,
type ConfigKey
} from './config.js'

describe('coverage', () => {
  it('describes every configuration key', () => {
    // The failure this prevents is silent: a key added to `config.ts` without
    // an entry here still resolves, still applies, and still appears in
    // `config show` — with no label, no summary and no way for the reader to
    // find out what it does.
    for (const key of CONFIG_KEYS) {
      const info = configInfo(key)
      expect(info.label, key).toBeTruthy()
      expect(info.summary, key).toBeTruthy()
      expect(info.detail, key).toBeTruthy()
      expect(info.detail.length, key).toBeGreaterThan(info.summary.length)
    }
  })
})

describe('acceptedValues', () => {
  it('states the range for a bounded number', () => {
    const bounds = configBounds('ask_grace_seconds')!
    expect(acceptedValues('ask_grace_seconds')).toBe(
      `a whole number from ${bounds.min}s–${bounds.max}s`,
    )
  })
})

describe('formatValue', () => {
  it('renders toggles as words rather than JSON', () => {
    expect(formatValue('ask_notifications', true)).toBe('yes')
    expect(formatValue('ask_notifications', false)).toBe('no')
  })
})

describe('formatDuration', () => {
  it('keeps exact values readable across scales', () => {
    expect(formatDuration(0, 's')).toBe('0s (immediately)')
    expect(formatDuration(45, 's')).toBe('45s')
    expect(formatDuration(120, 's')).toBe('2m')
    expect(formatDuration(3600, 's')).toBe('1h')
    expect(formatDuration(90, 's')).toBe('1m 30s')
  })
})

describe('describeSource', () => {
  it('turns a tagged path into words plus the file', () => {
    expect(describeSource('default')).toEqual({ label: 'default', path: null })
    expect(describeSource('global:/home/me/.config/notifai/config.toml')).toEqual({
      label: 'this machine',
      path: '/home/me/.config/notifai/config.toml',
    })
    expect(describeSource('project-local:/home/me/.config/notifai/projects/abc.toml')).toEqual({
      label: 'this project',
      path: '/home/me/.config/notifai/projects/abc.toml',
    })
  })

  it('does not invent a label for an unrecognised layer', () => {
    expect(describeSource('future-layer:/tmp/x').label).toBe('future-layer')
  })
})

describe('examples', () => {
  it('suggests a value `config set` would actually accept', () => {
    // The explain screen prints `notifai config set <key> <example>` as a
    // copyable line, so an example that fails validation is worse than none.
    for (const key of CONFIG_KEYS as readonly ConfigKey[]) {
      const info = configInfo(key)
      if (info.example === undefined) continue
      if (info.kind === 'integer') {
        const bounds = configBounds(key)
        const parsed = Number(info.example)
        expect(Number.isInteger(parsed), key).toBe(true)
        if (bounds) {
          expect(parsed, key).toBeGreaterThanOrEqual(bounds.min)
          expect(parsed, key).toBeLessThanOrEqual(bounds.max)
        }
      }
      if (info.kind === 'boolean') expect(['true', 'false']).toContain(info.example)
      if (info.kind === 'enum') expect(info.choices).toContain(info.example)
    }
  })
})
