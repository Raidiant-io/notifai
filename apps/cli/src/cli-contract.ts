import { isPrerelease } from './version.js'

export const CLI_PACKAGE_NAME = '@raidiant/notifai'

export const CLI_UPDATE_AVAILABLE = 'A newer Notifai is available.'
export const SERVICE_UPDATE_IN_PROGRESS = 'The service is being updated; try again later.'

export function cliPackageSpec(version: string): string {
  return `${CLI_PACKAGE_NAME}@${version}`
}

export function cliDistTagsUrl(): string {
  return `https://registry.npmjs.org/-/package/${CLI_PACKAGE_NAME}/dist-tags`
}

export type CliUpdateChannel = 'stable' | 'beta'

/** A prerelease installation belongs to the beta channel; everything else is stable. */
export function cliUpdateChannel(version: string | null): CliUpdateChannel {
  return version !== null && isPrerelease(version) ? 'beta' : 'stable'
}

/**
 * Resolve the current published CLI independently of every installed
 * `notifai` command. The fetched build owns the locally derived prefix repair,
 * so this action neither invokes the stale PATH winner nor exposes local
 * installation paths. A beta tester stays on the beta channel, which also
 * delivers a stable release once it is the newer one.
 */
export function cliUpdateRecoveryCommand(channel: CliUpdateChannel = 'stable'): string {
  return channel === 'beta'
    ? `npx --yes ${cliPackageSpec('beta')} update --channel beta`
    : `npx --yes ${cliPackageSpec('latest')} update`
}
