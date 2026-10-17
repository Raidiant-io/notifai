import { inspectSkillCopies, type SkillCopy, type SkillInventory, type SkillScope } from './native-skills.js'
import { HARNESS_LABELS, type SourceContextHarness } from './harnesses.js'
import { type ReadinessState } from './readiness.js'
import { packageVersion } from './release.js'
import type { CommandDeps } from './commands-core.js'

export const REFRESH_SKILL_COMMAND = 'notifai update --refresh-skill'

/** Every copy any harness loads, through the injected adapter when there is one. */
export function skillInventory(deps: CommandDeps): SkillInventory {
  return (deps.nativeSkills?.inspect ?? inspectSkillCopies)(deps.cwd, deps.env)
}

function labels(harnesses: readonly SourceContextHarness[]): string {
  return harnesses.map((harness) => HARNESS_LABELS[harness]).join(', ')
}

function unique(copies: readonly SkillCopy[]): SourceContextHarness[] {
  return [...new Set(copies.flatMap((copy) => copy.harnesses))]
}

/**
 * Whether each harness loads the guidance this CLI ships.
 *
 * A copy that is not current concerns only the harnesses that load it, so one
 * harness's outdated copy is never held against another. `selectedScope` and
 * `selectedHarnesses` are what setup was asked to place.
 */
export async function skillReadiness(
  deps: CommandDeps,
  selectedScope?: SkillScope,
  selectedHarnesses?: readonly string[],
): Promise<ReadinessState> {
  const { copies, expectedDigest, error } = skillInventory(deps)
  const base = { id: 'skill', title: 'Agent guidance skill' } as const
  if (expectedDigest === null) {
    return { ...base, status: 'gap',
      detail: 'this CLI cannot verify the guidance it ships, so no installed copy can be judged current',
      remedy: { by: 'user-here', summary: 'reinstall Notifai', command: 'notifai doctor --json' } }
  }
  if (error !== undefined) {
    return { ...base, status: 'optional-gap', detail: `could not finish checking installed guidance (${error})` }
  }

  if (selectedScope !== undefined) {
    const placed = (harness: string) => copies.some((copy) => copy.scopes.includes(selectedScope) &&
      copy.condition === 'current' && copy.harnesses.includes(harness as SourceContextHarness))
    const wanted = selectedHarnesses ?? unique(copies)
    const missing = wanted.filter((harness) => !placed(harness))
    if (wanted.length === 0 || missing.length > 0) {
      return { ...base, status: 'gap',
        detail: wanted.length === 0
          ? `not installed in the ${selectedScope} scope`
          : `${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not load current guidance from the ${selectedScope} scope`,
        remedy: { by: 'cli', summary: `install the bundled skill in the ${selectedScope} scope`,
          command: `notifai init --skills --skills-scope ${selectedScope}${selectedHarnesses === undefined ? '' : ` --skills-harness ${selectedHarnesses.join(',')}`}` } }
    }
  }

  const outdated = copies.filter((copy) => copy.condition !== 'current')
  if (outdated.length > 0) {
    return { ...base, status: 'gap', harnesses: unique(outdated),
      detail: outdated.map((copy) => `${labels(copy.harnesses)} ${copy.harnesses.length === 1 ? 'loads' : 'load'} ` +
        `${copy.condition === 'stale' ? 'outdated' : 'unreadable'} guidance from ${copy.path}`).join('; '),
      technical: { copies: outdated.map(({ scopes, path, harnesses, condition, problem }) =>
        ({ scopes, path, harnesses, condition, problem: problem ?? null })) },
      remedy: { by: 'cli', summary: 'rewrite every Notifai skill copy with the guidance shipped in this CLI',
        command: REFRESH_SKILL_COMMAND } }
  }

  // Two different directories, one per scope; one directory serving both is a single copy.
  const both = unique(copies.filter((copy) => copy.scopes.includes('project'))).filter((harness) => {
    const loaded = copies.filter((copy) => copy.harnesses.includes(harness))
    return loaded.some((a) => a.scopes.includes('project') && loaded.some((b) => b !== a && b.scopes.includes('global')))
  })
  if (both.length > 0) {
    return { ...base, status: 'optional-gap', harnesses: both,
      detail: `${labels(both)} ${both.length === 1 ? 'loads' : 'load'} the skill from both this project and the machine-global scope`,
      remedy: { by: 'cli', summary: 'keep one scope', command: 'notifai init --skills --skills-scope global' } }
  }

  if (copies.length === 0) {
    return { ...base, status: 'optional-gap', detail: 'not installed for any harness',
      remedy: { by: 'cli', summary: 'install the skill agents follow when deciding to notify',
        command: 'notifai init --skills --skills-scope global' } }
  }
  return { ...base, status: 'ready',
    detail: `${labels(unique(copies))} ${unique(copies).length === 1 ? 'loads' : 'load'} the guidance shipped with CLI ${packageVersion() ?? 'of this version'}` }
}
