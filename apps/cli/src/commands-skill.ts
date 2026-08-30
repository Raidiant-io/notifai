import { SKILLS_INSTALLER_SPEC, type NativeSkill, type SkillScope } from './native-skills.js'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type ReadinessState } from './readiness.js'
import { packageVersion, skillsSource } from './release.js'
import { createSkillManifest, shippedSkillBundle } from './skill-integrity.js'
import type { CommandDeps } from './commands-core.js'

/**
 * Where `npx skills add` fetches the optional agent skill from, derived from
 * this build's own version so the pin cannot drift from the release it names.
 * Null when the build cannot establish its version; see `./release.js`.
 */
export const SKILLS_SOURCE: string | null = skillsSource()

/**
 * How to refer to the pin in user-facing text.
 *
 * Only reached in a corrupted install, where naming the tag is impossible but
 * saying nothing would be worse — the sentence still has to read as English.
 */
const SKILLS_SOURCE_LABEL = SKILLS_SOURCE ?? 'the public release tag matching this CLI'

const SKILL_SCOPES: readonly SkillScope[] = ['project', 'global']

function skillTreeDigest(root: string): string | null {
  if (!existsSync(root)) return null
  try {
    return createSkillManifest(root, '').digest
  } catch {
    return null
  }
}

function expectedSkillDigest(): string | null {
  const version = packageVersion()
  if (version === null) return null
  const bundle = shippedSkillBundle(version)
  return bundle.ok ? bundle.bundle.manifest.digest : null
}

function developmentSkillMismatch(skill: NativeSkill): { checkout: string; installed: string } | null {
  const checkoutRoot = fileURLToPath(new URL('../../../skills/notifai/', import.meta.url))
  const checkout = skillTreeDigest(checkoutRoot)
  const installed = skillTreeDigest(skill.path)
  return checkout !== null && installed !== null && checkout !== installed
    ? { checkout, installed }
    : null
}

function skillSourceParts(): { source: string; ref: string } | null {
  if (SKILLS_SOURCE === null) return null
  const match = /^([^#]+)#(.+)$/.exec(SKILLS_SOURCE)
  return match === null ? null : { source: match[1]!, ref: match[2]! }
}

function expectedSkillProvenance(skill: NativeSkill): boolean {
  const expected = skillSourceParts()
  return (
    expected !== null &&
    skill.name === 'notifai' &&
    skill.source === expected.source &&
    skill.sourceType === 'github' &&
    (skill.ref === expected.ref || (skill.ref !== null && /^[0-9a-f]{40}$/.test(skill.ref)))
  )
}

function expectedSkill(skill: NativeSkill): boolean {
  const expectedDigest = expectedSkillDigest()
  return (
    expectedSkillProvenance(skill) &&
    expectedDigest !== null &&
    skillTreeDigest(skill.path) === expectedDigest
  )
}

function skillPin(skill: NativeSkill): string {
  return skill.ref ?? 'unknown pin'
}

export interface ScopedNotifaiSkills {
  installed: NativeSkill[]
  errors: string[]
}

/**
 * Installer-managed notifai skills in both scopes. Duplicate detection has to
 * see the pair; a selected-scope filter would hide the copy the harness still
 * lists.
 */
export async function listScopedNotifaiSkills(deps: CommandDeps): Promise<ScopedNotifaiSkills> {
  const results = await Promise.all(
    SKILL_SCOPES.map(async (scope) => {
      if (deps.nativeSkills === undefined) return { scope, skills: [] as NativeSkill[] }
      try {
        return { scope, ...(await deps.nativeSkills.list(scope, deps.cwd, deps.env)) }
      } catch (err) {
        return { scope, skills: [] as NativeSkill[], error: String(err) }
      }
    }),
  )
  return {
    installed: results.flatMap(({ skills }) => skills.filter((skill) => skill.name === 'notifai')),
    errors: results
      .filter((result) => result.error !== undefined)
      .map((result) => `${result.scope}: ${result.error}`),
  }
}

function duplicateSkillState(installed: NativeSkill[], selectedScope?: SkillScope): ReadinessState {
  const project = installed.find((skill) => skill.scope === 'project')
  const global = installed.find((skill) => skill.scope === 'global')
  const projectPin = project === undefined ? 'not installed' : skillPin(project)
  const globalPin = global === undefined ? 'not installed' : skillPin(global)
  return {
    id: 'skill',
    title: 'Agent guidance skill',
    status: 'gap',
    detail:
      `project (${projectPin}) and global (${globalPin}) are both installed, so the harness lists both. ` +
      'Keep either project or global and uninstall the other.',
    technical: {
      project:
        project === undefined
          ? null
          : { ref: project.ref, path: project.path, current: expectedSkill(project) },
      global:
        global === undefined
          ? null
          : { ref: global.ref, path: global.path, current: expectedSkill(global) },
      resolution: 'both-listed',
    },
    remedy:
      selectedScope === undefined
        ? {
            by: 'user-here',
            summary:
              'keep either the project or the machine-global skill and uninstall the other; add --global to remove the machine-global copy',
            command: `npx -y ${SKILLS_INSTALLER_SPEC} remove notifai`,
          }
        : {
            by: 'cli',
            summary: `keep the ${selectedScope} skill and uninstall the other`,
            command: `notifai init --skills --setup-scope ${selectedScope}`,
          },
  }
}

export async function skillReadiness(
  deps: CommandDeps,
  selectedScope?: SkillScope,
): Promise<ReadinessState> {
  const { installed, errors } = await listScopedNotifaiSkills(deps)
  if (installed.length > 1) return duplicateSkillState(installed, selectedScope)

  const candidate = installed.find(expectedSkillProvenance)
  if (candidate !== undefined) {
    const mismatch = developmentSkillMismatch(candidate)
    if (mismatch !== null) {
      return {
        id: 'skill',
        title: 'Agent guidance skill',
        status: 'gap',
        detail:
          `the active development CLI's shipped guidance differs from the installer-managed ${skillPin(candidate)} skill. ` +
          'Released installs remain immutable; publish a new CLI/skill release before treating this combination as ready.',
        technical: {
          resolution: 'development-cli-skill-mismatch',
          scope: candidate.scope,
          ref: candidate.ref,
          path: candidate.path,
          checkout_digest: mismatch.checkout,
          installed_digest: mismatch.installed,
        },
      }
    }
    const expectedDigest = expectedSkillDigest()
    const installedDigest = skillTreeDigest(candidate.path)
    if (expectedDigest === null || installedDigest !== expectedDigest) {
      return {
        id: 'skill',
        title: 'Agent guidance skill',
        status: 'gap',
        detail:
          'the installer record names this release, but the installed guidance does not match ' +
          'the content shipped inside this CLI package.',
        technical: {
          resolution: 'installed-skill-content-mismatch',
          scope: candidate.scope,
          ref: candidate.ref,
          path: candidate.path,
          expected_digest: expectedDigest,
          installed_digest: installedDigest,
        },
        remedy: {
          by: 'cli',
          summary: 'reinstall the content-verified skill shipped with this CLI',
          command: `notifai init --skills --setup-scope ${candidate.scope}`,
        },
      }
    }
    return {
      id: 'skill',
      title: 'Agent guidance skill',
      status: 'ready',
      detail:
        `installed in the ${candidate.scope} scope and verified against the guidance ` +
        `shipped with ${SKILLS_SOURCE_LABEL}`,
    }
  }

  const scopeText = selectedScope === undefined ? 'project or machine-global scope' : `${selectedScope} scope`
  return {
    id: 'skill',
    title: 'Agent guidance skill',
    status: 'optional-gap',
    detail:
      errors.length > 0
        ? `could not verify installer-managed state in ${scopeText} (${errors.join('; ')})`
        : `not installed from ${SKILLS_SOURCE_LABEL} in ${scopeText}`,
    remedy: {
      by: 'cli',
      summary: 'install the skill agents follow when deciding to notify',
      command:
        selectedScope === undefined
          ? 'notifai init --skills --setup-scope project'
          : `notifai init --skills --setup-scope ${selectedScope}`,
    },
  }
}
