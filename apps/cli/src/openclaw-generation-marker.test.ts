import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openclawFinalState } from './commands-hook-attend.js'
import {
  OPENCLAW_GENERATION_MARKER_ENV,
  openclawGenerationLoaded,
  openclawGenerationMarker,
} from './openclaw-generation-marker.js'
import { openclawPluginSource } from './openclaw-plugin.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const GATEWAY = 4242

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-marker-'))
  roots.push(root)
  const marker = path.join(root, 'plugin-generation.json')
  let now = 0
  const sleeps: number[] = []
  const clock = {
    monotonic: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      now += ms
      onSleep?.(now)
    },
  }
  let onSleep: ((now: number) => void) | undefined
  const load = (pid = GATEWAY, generation = 'gen-next') =>
    writeFileSync(marker, JSON.stringify({ pid, boot_id: 'boot', generation }))
  return { marker, clock, load, sleeps, whenAt: (fn: (now: number) => void) => { onSleep = fn } }
}

describe('whether a Notifai plugin generation is loaded in the Gateway', () => {
  it('reads only a marker from the same Gateway process', () => {
    const t = setup()
    expect(openclawGenerationLoaded(t.marker, GATEWAY)).toBe(false)
    t.load(GATEWAY + 1)
    expect(openclawGenerationLoaded(t.marker, GATEWAY)).toBe(false)
    t.load()
    expect(openclawGenerationLoaded(t.marker, GATEWAY)).toBe(true)
    writeFileSync(t.marker, 'not json')
    expect(openclawGenerationLoaded(t.marker, GATEWAY)).toBe(false)
  })

  it('takes the marker path only from an absolute plugin-supplied value', () => {
    expect(openclawGenerationMarker({})).toBeNull()
    expect(openclawGenerationMarker({ [OPENCLAW_GENERATION_MARKER_ENV]: 'relative.json' })).toBeNull()
    expect(openclawGenerationMarker({ [OPENCLAW_GENERATION_MARKER_ENV]: '/state/notifai/plugin-generation.json' }))
      .toBe('/state/notifai/plugin-generation.json')
  })
})

describe('what an OpenClaw attendant reports when it stops in a running Gateway', () => {
  it('hands over on a reload: the next generation loads within the grace period', async () => {
    const t = setup()
    t.whenAt((now) => { if (now >= 1_000) t.load() })
    expect(await openclawFinalState('superseded', { steppedAside: true, marker: t.marker, gatewayPid: GATEWAY, clock: t.clock }))
      .toBe('withdrawn')
  })

  it('ends the session on a disable: no generation loads, so nothing can reach it', async () => {
    const t = setup()
    expect(await openclawFinalState('superseded', {
      steppedAside: true, marker: t.marker, gatewayPid: GATEWAY, clock: t.clock, graceMs: 5_000,
    })).toBe('ended')
    expect(t.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(5_000)
  })

  it('ends the session when Notifai is uninstalled, at once', async () => {
    const t = setup()
    t.load()
    expect(await openclawFinalState('gate:uninstall-in-progress', {
      steppedAside: false, marker: t.marker, gatewayPid: GATEWAY, clock: t.clock,
    })).toBe('ended')
    expect(t.sleeps).toEqual([])
  })

  it('ends the session when the plugin installation is removed and no generation stays loaded', async () => {
    const t = setup()
    expect(await openclawFinalState('gate:attend-handler-removed', {
      steppedAside: false, marker: t.marker, gatewayPid: GATEWAY, clock: t.clock, graceMs: 1_000,
    })).toBe('ended')
    t.load()
    expect(await openclawFinalState('gate:attend-handler-removed', {
      steppedAside: false, marker: t.marker, gatewayPid: GATEWAY, clock: t.clock, graceMs: 1_000,
    })).toBe('withdrawn')
  })

  it('keeps the default for every other stop, and for a plugin that names no marker', async () => {
    const t = setup()
    const context = { steppedAside: false, marker: t.marker, gatewayPid: GATEWAY, clock: t.clock }
    // Another start of the same session superseded it: that one attends now.
    expect(await openclawFinalState('superseded', context)).toBeUndefined()
    expect(await openclawFinalState('signal', context)).toBeUndefined()
    expect(await openclawFinalState('harness-gone', context)).toBeUndefined()
    expect(await openclawFinalState('superseded', { ...context, steppedAside: true, marker: null })).toBeUndefined()
    expect(t.sleeps).toEqual([])
  })
})

describe('the generated plugin marks its loaded generation', () => {
  const source = openclawPluginSource({ adapterPath: '/adapter/notifai', timeoutSeconds: 15 })

  it('writes the marker when its Gateway service starts and removes only its own when it stops', () => {
    expect(source).toContain('plugin-generation.json')
    expect(source).toMatch(/start\(ctx\)[\s\S]*writeGenerationMarker\(\)[\s\S]*continuationService\.start\(\)/)
    expect(source).toMatch(/async stop\(\) \{\s*clearGenerationMarker\(\)/)
    expect(source).toContain('generation === PLUGIN_GENERATION_ID) unlinkSync(file)')
  })

  it('names the marker to each attendant it starts', () => {
    expect(source).toContain(`${OPENCLAW_GENERATION_MARKER_ENV}: generationMarkerPath()`)
  })
})
