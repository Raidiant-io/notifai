/** Paths that warrant checking bundled placement from the exact packed CLI. */
export const PACKED_SKILL_SMOKE_PATHS = Object.freeze([
  'apps/cli/src/native-skills.ts',
  'apps/cli/src/skill-installation.ts',
  'apps/cli/src/platform.ts',
  'apps/cli/src/skill-integrity.ts',
  'apps/cli/src/commands-skill.ts',
  'skills/notifai/',
  'scripts/verify-packed-skill-install.mjs',
  'scripts/packed-skill-smoke.mjs',
])

export const PACKED_SKILL_SMOKE_TIMEOUTS = Object.freeze({
  pack: 120_000,
  extract: 15_000,
  npmInstall: 120_000,
  cliCommand: 20_000,
})

export function skillSmokeWarranted(paths) {
  return paths.some((file) => {
    const normalized = file.replaceAll('\\', '/')
    return PACKED_SKILL_SMOKE_PATHS.some(
      (prefix) => normalized === prefix || normalized.startsWith(prefix),
    )
  })
}
