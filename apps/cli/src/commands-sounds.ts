import type { ListSoundsResponse, SoundView } from '@raidiant/notifai-protocol'
import {
  EXIT,
  authedClient,
  loadLoggedConfig,
  reportError,
  type CommandDeps,
} from './commands-core.js'
import { SHIPPED_SOUND_LISTING } from './sound-ref.js'

export interface SoundsListing {
  shipped: readonly { ref: string; name: string }[]
  custom: SoundView[]
}

function formatSoundDuration(ms: number): string {
  const seconds = ms / 1000
  const text = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)
  return `${text}s`
}

export async function soundsCommand(
  deps: CommandDeps,
  flags: { json?: boolean },
): Promise<number> {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const result: ListSoundsResponse = await authed.client.listSounds()
    const listing: SoundsListing = {
      shipped: SHIPPED_SOUND_LISTING,
      custom: result.sounds,
    }
    if (flags.json) {
      deps.io.out(JSON.stringify(listing, null, 2))
      return EXIT.ok
    }
    for (const sound of listing.shipped) {
      deps.io.out(`${sound.ref}  ${sound.name}`)
    }
    for (const sound of listing.custom) {
      deps.io.out(`${sound.sound_id}  ${sound.name}  ${formatSoundDuration(sound.duration_ms)}`)
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}
