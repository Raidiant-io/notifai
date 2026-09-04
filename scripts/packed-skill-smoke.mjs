/**
 * Paths whose change warrants the packed skills-installer integration smoke.
 *
 * The deterministic packed-install gate never spawns `npm exec`. The published
 * `skills` installer is a separate third-party seam: registry metadata can
 * respond while `npm exec skills@…` never launches the package. Run that smoke
 * when the adapter, pin, or packaged bundle changes, and whenever release
 * evidence has to prove the installer still consumes the packed skill.
 */
export const PACKED_SKILL_SMOKE_PATHS = Object.freeze([
  'apps/cli/src/native-skills.ts',
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
  registryMetadata: 10_000,
  npmExecSkills: 45_000,
})

export function skillSmokeWarranted(paths) {
  return paths.some((file) => {
    const normalized = file.replaceAll('\\', '/')
    return PACKED_SKILL_SMOKE_PATHS.some(
      (prefix) => normalized === prefix || normalized.startsWith(prefix),
    )
  })
}
