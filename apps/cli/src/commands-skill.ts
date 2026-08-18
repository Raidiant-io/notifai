import type { NativeSkill, SkillScope } from './native-skills.js'
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

export async function skillReadiness(
  deps: CommandDeps,
  selectedScope?: SkillScope,
): Promise<ReadinessState> {
  const scopes: SkillScope[] = selectedScope === undefined ? ['project', 'global'] : [selectedScope]
  const results = await Promise.all(
    scopes.map(async (scope) => {
      if (deps.nativeSkills === undefined) return { scope, skills: [] as NativeSkill[] }
      try {
        return { scope, ...(await deps.nativeSkills.list(scope, deps.cwd, deps.env)) }
      } catch (err) {
        return { scope, skills: [] as NativeSkill[], error: String(err) }
      }
    }),
  )
  const installed = results.flatMap(({ skills }) => skills).find(expectedSkill)
  if (installed !== undefined) {
    return {
      id: 'skill',
      title: 'Agent guidance skill',
      status: 'ready',
      detail: `installed from ${SKILLS_SOURCE_LABEL} in the ${installed.scope} scope`,
    }
  }

  const errors = results
    .filter((result) => result.error !== undefined)
    .map((result) => `${result.scope}: ${result.error}`)
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
          ? 'notifai init --skills'
          : `notifai init --skills --skills-scope ${selectedScope}`,
    },
  }
}
