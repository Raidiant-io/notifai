/**
 * Whether a Notifai plugin generation is loaded in an OpenClaw Gateway.
 *
 * The plugin's Gateway service writes this marker when it starts and removes
 * it when it stops. A running Gateway that reloads the plugin stops the old
 * generation, then starts the new one, which writes the marker again; a
 * Gateway that disables or uninstalls the plugin stops it and starts nothing.
 * An attendant told to step aside cannot tell those apart at that moment, so
 * it waits a short while for the marker. If no generation loads, Notifai can
 * never deliver into the session again and its questions must expire.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** The marker path, passed by the plugin to each attendant it starts. */
export const OPENCLAW_GENERATION_MARKER_ENV = 'NOTIFAI_OPENCLAW_GENERATION_MARKER'

/** How long a stepped-aside attendant waits for a next generation to load. */
export const OPENCLAW_SUCCESSOR_GRACE_MS = 20_000

const POLL_MS = 250

/** The marker path the plugin named, or null for a plugin that names none. */
export function openclawGenerationMarker(env: NodeJS.ProcessEnv): string | null {
  const value = env[OPENCLAW_GENERATION_MARKER_ENV]?.trim()
  return value !== undefined && value !== '' && path.isAbsolute(value) ? value : null
}

/** True when the marker names a generation loaded in this exact Gateway process. */
export function openclawGenerationLoaded(file: string, gatewayPid: number): boolean {
  try {
    const marker = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; generation?: unknown }
    return marker.pid === gatewayPid && typeof marker.generation === 'string' && marker.generation !== ''
  } catch {
    return false
  }
}

/** Wait up to the grace period for a loaded generation. */
export async function awaitOpenclawGeneration(
  file: string,
  gatewayPid: number,
  clock: { monotonic(): number; sleep(ms: number): Promise<void> },
  graceMs = OPENCLAW_SUCCESSOR_GRACE_MS,
): Promise<boolean> {
  const deadline = clock.monotonic() + graceMs
  for (;;) {
    if (openclawGenerationLoaded(file, gatewayPid)) return true
    if (clock.monotonic() >= deadline) return false
    await clock.sleep(POLL_MS)
  }
}
