/**
 * Resolve the current published CLI independently of every installed
 * `notifai` command. The fetched build owns the locally derived prefix repair,
 * so this action neither invokes the stale PATH winner nor exposes local
 * installation paths.
 */
export function cliUpdateRecoveryCommand(): string {
  return 'npx --yes @raidiant/notifai@latest update'
}
