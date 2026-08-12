import { describe, expect, it } from 'vitest'
import {
  BOOLEAN_CONFIG_KEYS,
  CONFIG_KEYS,
  NUMERIC_CONFIG_KEYS,
  configBounds,
  type ConfigKey,
} from './config.js'
import {
  CONFIG_GROUPS,
  acceptedValues,
  configInfo,
  configKeysByGroup,
  describeSource,
  formatDuration,
  formatValue,
} from './config-schema.js'

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

  it('files every key under exactly one declared group', () => {
    const grouped = CONFIG_GROUPS.flatMap((group) => configKeysByGroup(group.id).map((info) => info.key))
    expect([...grouped].sort()).toEqual([...CONFIG_KEYS].sort())
  })

  it('keeps summaries short enough to sit beside a value', () => {
    for (const key of CONFIG_KEYS) {
      expect(configInfo(key).summary.length, key).toBeLessThanOrEqual(80)
    }
  })

  it('agrees with config.ts about which keys are numbers and toggles', () => {
    // Two sources of truth for a key's type would let the prompt offer a text
    // box for something `config set` will only accept as `true` or `false`.
    for (const key of NUMERIC_CONFIG_KEYS) expect(configInfo(key).kind, key).toBe('integer')
    for (const key of BOOLEAN_CONFIG_KEYS) expect(configInfo(key).kind, key).toBe('boolean')
  })

  it('offers choices for every enum key', () => {
    for (const key of CONFIG_KEYS) {
      const info = configInfo(key)
      if (info.kind !== 'enum') continue
      expect(info.choices, key).toBeDefined()
      expect(info.choices!.length, key).toBeGreaterThan(1)
      for (const choice of info.choices!) expect(info.choiceHints?.[choice], `${key}.${choice}`).toBeTruthy()
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

  it('lists the choices for an enum', () => {
    expect(acceptedValues('sound')).toContain('none')
  })

  it('names both values for a toggle', () => {
    expect(acceptedValues('ask_notifications')).toBe('true or false')
  })
})

describe('formatValue', () => {
  it('renders toggles as words rather than JSON', () => {
    expect(formatValue('ask_notifications', true)).toBe('yes')
    expect(formatValue('ask_notifications', false)).toBe('no')
  })

  it('explains what an unset value means instead of printing null', () => {
    // `sound = null` is accurate and tells the reader nothing about what will
    // happen; the whole complaint about the old output in one line.
    expect(formatValue('sound', null)).toBe('each notification uses the sound for its kind')
    expect(formatValue('devices', null)).toBe('every device that can receive')
  })

  it('renders durations in units a person reads', () => {
    expect(formatValue('ask_grace_seconds', 300)).toBe('5m')
    expect(formatValue('ttl_seconds', 86400)).toBe('1d')
    expect(formatValue('wait_seconds', 10)).toBe('10s')
  })

  it('joins a device list', () => {
    expect(formatValue('devices', ['dev_a', 'dev_b'])).toBe('dev_a, dev_b')
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
    expect(describeSource('project:/repo/.notifai/config.toml').label).toBe('this project (shared)')
    expect(describeSource('project-local:/repo/.notifai/config.local.toml').label).toBe(
      'this project (personal)',
    )
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
