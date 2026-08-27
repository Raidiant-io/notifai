import { SKILLS_INSTALLER_SPEC, type NativeSkill, type SkillScope } from './native-skills.js'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ReadinessState } from './readiness.js'
import { skillsSource } from './release.js'
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

function markdownTreeDigest(root: string): string | null {
  if (!existsSync(root)) return null
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(absolute)
    }
  }
  try {
    walk(root)
    const hash = createHash('sha256')
    for (const file of files.sort()) {
      hash.update(path.relative(root, file))
      hash.update('\0')
      hash.update(readFileSync(file))
      hash.update('\0')
    }
    return `sha256:${hash.digest('hex')}`
  } catch {
    return null
  }
}

function developmentSkillMismatch(skill: NativeSkill): { checkout: string; installed: string } | null {
  const checkoutRoot = fileURLToPath(new URL('../../../skills/notifai/', import.meta.url))
  const checkout = markdownTreeDigest(checkoutRoot)
  const installed = markdownTreeDigest(skill.path)
  return checkout !== null && installed !== null && checkout !== installed
    ? { checkout, installed }
    : null
}

function skillSourceParts(): { source: string; ref: string } | null {
  if (SKILLS_SOURCE === null) return null
  const match = /^([^#]+)#(.+)$/.exec(SKILLS_SOURCE)
  return match === null ? null : { source: match[1]!, ref: match[2]! }
}

function expectedSkill(skill: NativeSkill): boolean {
  const expected = skillSourceParts()
  return (
    expected !== null &&
    skill.name === 'notifai' &&
    skill.source === expected.source &&
    skill.sourceType === 'github' &&
    skill.ref === expected.ref
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

  const current = installed.find(expectedSkill)
  if (current !== undefined) {
    const mismatch = developmentSkillMismatch(current)
    if (mismatch !== null) {
      return {
        id: 'skill',
        title: 'Agent guidance skill',
        status: 'gap',
        detail:
          `the active development CLI's shipped guidance differs from the installer-managed ${skillPin(current)} skill. ` +
          'Released installs remain immutable; publish a new CLI/skill release before treating this combination as ready.',
        technical: {
          resolution: 'development-cli-skill-mismatch',
          scope: current.scope,
          ref: current.ref,
          path: current.path,
          checkout_digest: mismatch.checkout,
          installed_digest: mismatch.installed,
        },
      }
    }
    return {
      id: 'skill',
      title: 'Agent guidance skill',
      status: 'ready',
      detail: `installed from ${SKILLS_SOURCE_LABEL} in the ${current.scope} scope`,
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
