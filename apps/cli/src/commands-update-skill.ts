import { EXIT, type CommandDeps } from './commands-core.js'
import { installedSkillMatchesPackage, listScopedNotifaiSkills, SKILLS_SOURCE } from './commands-skill.js'

/** Refresh one existing scope through the native installer, without setup. */
export async function updateSkillCommand(deps: CommandDeps, flags: { json?: boolean }): Promise<number> {
  const fail = (error: string): number => {
    if (flags.json === true || deps.io.interactive !== true) deps.io.out(JSON.stringify({ ok: false, error }))
    else deps.io.err(error)
    return EXIT.failed
  }
  const inventory = await listScopedNotifaiSkills(deps)
  if (inventory.errors.length > 0 || inventory.installed.length !== 1) {
    return fail('Skill refresh needs exactly one readable existing installation. Resolve missing or duplicate scope through setup first.')
  }
  const skill = inventory.installed[0]!
  if (deps.nativeSkills === undefined || SKILLS_SOURCE === null) return fail('The packaged skill installer is unavailable.')
  const changed = !installedSkillMatchesPackage(skill)
  if (changed) {
    const operation = await deps.nativeSkills.add({ source: SKILLS_SOURCE, skill: 'notifai', scope: skill.scope,
      cwd: deps.cwd, env: deps.env, diagnosticsToStderr: true }).catch((error: unknown) => ({ code: 1, error: String(error) }))
    if ((typeof operation === 'number' ? operation : operation.code) !== 0) {
      return fail(typeof operation === 'number' ? 'The native skill installer failed.' : operation.error)
    }
  }
  const after = await listScopedNotifaiSkills(deps)
  if (after.errors.length > 0 || after.installed.length !== 1 || after.installed[0]?.scope !== skill.scope ||
      !installedSkillMatchesPackage(after.installed[0]!)) return fail('The refreshed skill could not be verified in its original scope.')
  const report = { ok: true, changed, scope: skill.scope, path: after.installed[0]!.path,
    next_step: 'Read the refreshed SKILL.md and references/updates.md, then run notifai guidance in this Agent Session.' }
  deps.io.out(flags.json === true || deps.io.interactive !== true ? JSON.stringify(report, null, 2) : report.next_step)
  return EXIT.ok
}
