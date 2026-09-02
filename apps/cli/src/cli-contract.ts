export const CLI_PACKAGE_NAME = '@raidiant/notifai'

export const CLI_UPDATE_AVAILABLE = 'A newer Notifai is available.'
export const SERVICE_UPDATE_IN_PROGRESS = 'The service is being updated; try again later.'

export function cliPackageSpec(version: string): string {
  return `${CLI_PACKAGE_NAME}@${version}`
}

export function cliDistTagsUrl(): string {
  return `https://registry.npmjs.org/-/package/${CLI_PACKAGE_NAME}/dist-tags`
}

/**
 * Resolve the current published CLI independently of every installed
 * `notifai` command. The fetched build owns the locally derived prefix repair,
 * so this action neither invokes the stale PATH winner nor exposes local
 * installation paths.
 */
export function cliUpdateRecoveryCommand(): string {
  return `npx --yes ${cliPackageSpec('latest')} update`
}
