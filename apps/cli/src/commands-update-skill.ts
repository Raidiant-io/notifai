import { EXIT, type CommandDeps } from './commands-core.js'
import { skillInventory } from './commands-skill.js'
import { integrationPublication, type IntegrationPublication } from './native-installation.js'

/** Rewrite every installed Notifai skill copy with this CLI's guidance, without setup. */
export async function updateSkillCommand(deps: CommandDeps, flags: { json?: boolean }, publication?: IntegrationPublication): Promise<number> {
  const structured = flags.json === true || deps.io.interactive !== true
  const fail = (error: string): number => {
    if (structured) deps.io.out(JSON.stringify({ ok: false, error }))
    else deps.io.err(error)
    return EXIT.failed
  }
  if (deps.nativeSkills === undefined) return fail('The packaged skill installer is unavailable.')
  let publish: IntegrationPublication
  try { publish = publication ?? integrationPublication(deps) } catch (error) { return fail(String(error)) }
  const result = await deps.nativeSkills.refresh({ cwd: deps.cwd, env: deps.env, publishIntegration: publish })
    .catch((error: unknown) => ({ ok: false, changed: [] as string[], error: String(error) }))
  if (!result.ok) return fail(result.error ?? 'The skill refresh failed.')
  const after = skillInventory(deps)
  const outdated = after.copies.filter((copy) => copy.condition !== 'current')
  if (after.error !== undefined || outdated.length > 0) {
    return fail(after.error ?? `Could not verify the refreshed guidance at ${outdated.map((copy) => copy.path).join(', ')}.`)
  }
  const report = { ok: true, changed: result.changed.length > 0, refreshed: result.changed,
    copies: after.copies.map(({ scopes, path, harnesses }) => ({ scopes, path, harnesses })),
    next_step: after.copies.length === 0
      ? 'No Notifai skill is installed. Run notifai init --skills --skills-scope global to install it.'
      : 'Read the refreshed SKILL.md and references/updates.md, then run notifai guidance in this Agent Session.' }
  deps.io.out(structured ? JSON.stringify(report, null, 2) : report.next_step)
  return EXIT.ok
}
