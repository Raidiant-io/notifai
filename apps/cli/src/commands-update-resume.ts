/** Resume owned integration work using this installed package's authority. */
import { readFileSync } from 'node:fs'
import { EXIT, type CommandDeps } from './commands-core.js'
import { resolveActiveHarness } from './commands-harness-context.js'
import { activeQuestionRouteProblems } from './commands-hook-diagnostics.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import { listScopedNotifaiSkills } from './commands-skill.js'
import { updateSkillCommand } from './commands-update-skill.js'
import { hookAdapterTargetsArtifact, inspectHookAdapter, installHookAdapter, isNpxAdapterTarget } from './hook-adapter.js'
import { pendingList, readSessionState } from './hook-session-state.js'
import { installationFaults, localIntegrationAssessment } from './integration-health.js'
import { packageVersion } from './release.js'
import { installedChangelog } from './update-handoff.js'
import { isSemVer } from './version.js'
import { isHookInstallableHarness, questionRoutingCapability } from './harnesses.js'
import { sameLocalPath } from './local-path.js'
import { codexToolHookReady, CODEX_TOOL_HOOK_RECOVERY } from './codex-tool-messages.js'
import { activateInstalledAttendants, type AttendantActivation } from './attendant-update.js'

/** Never replace package files while this exact owner still owes an answer. */
export function updateWorkPending(deps: CommandDeps): string | null {
  const active = resolveActiveHarness(deps.env, deps.cwd, (deps.now ?? Date.now)())
  if (active.contested.length > 0) return 'Several Agent Sessions could own this invocation; resume from an unambiguous Agent Session.'
  const owner = active.active
  if (owner?.sessionId === undefined) return null
  const state = readSessionState(owner.sessionId, deps.env)
  return pendingList(state).length > 0 || (state.acknowledgement_due?.length ?? 0) > 0 ||
    (state.message_acknowledgement_due?.length ?? 0) > 0 ||
    state.accepted !== undefined || (state.delivered_answers?.length ?? 0) > 0
    ? 'Finish outstanding questions, answers and Agent Acknowledgements first; preserve their IDs and waiters.' : null
}

export async function updateResumeCommand(deps: CommandDeps, flags: { json?: boolean; from?: string }): Promise<number> {
  if (flags.from !== undefined && !isSemVer(flags.from)) {
    deps.io.err('--from must be a semantic version')
    return EXIT.usage
  }
  const pending: string[] = []
  const changed: string[] = []
  let attendants: AttendantActivation[] = []
  const report = (filesComplete: boolean): number => {
    const complete = filesComplete && pending.length === 0
    const result = { ok: filesComplete, read_only: false, running_version: packageVersion(),
      files_complete: filesComplete, migration_complete: complete, pending_actions: pending, changed, attendants,
      resume_command: 'notifai update --resume --json', changelog: installedChangelog(packageVersion(), flags.from),
      next_step: 'Read this package’s SKILL.md and references/updates.md, then run notifai guidance in the active Agent Session. Preserve outstanding work and existing User deferrals.' }
    if (flags.json === true || deps.io.interactive !== true) deps.io.out(JSON.stringify(result, null, 2))
    else deps.io.out(complete ? 'Update integration is verified. Reread changed agent guidance; no restart is implied.'
      : `Update integration remains pending: ${pending.join('; ')}. Resume with notifai update --resume --json.`)
    return filesComplete ? EXIT.ok : EXIT.failed
  }
  const quietIo = { ...deps.io, confirm: deps.io.confirm.bind(deps.io), openUrl: deps.io.openUrl.bind(deps.io),
    out: (_line: string) => {}, err: (line: string) => pending.push(line) }
  const repairDeps = { ...deps, io: quietIo }
  try {
    let assessment = localIntegrationAssessment(deps)
    const effective = assessment.cli.effective
    // A command invoked through another prefix has no authority to retarget
    // shared integration or replace its guidance merely because it can run.
    if (effective?.artifact_path === null || effective === null ||
        !hookAdapterTargetsArtifact({ execPath: process.execPath, scriptPath: assessment.cli.current.artifact_path }, effective.artifact_path)) {
      pending.push('Resolve the effective installation before resuming integration; run notifai doctor --json.')
      return report(false)
    }
    const active = resolveActiveHarness(deps.env, deps.cwd, (deps.now ?? Date.now)())
    const owner = active.contested.length === 0 ? active.active : null
    const waiting = updateWorkPending(deps)
    if (waiting !== null) {
      pending.push(waiting)
      return report(false)
    }
    const inventory = await listScopedNotifaiSkills(deps)
    if (inventory.errors.length > 0 || inventory.installed.length > 1) {
      pending.push('Resolve unreadable or duplicate skill scopes before integration repair; no scope was selected.')
      return report(false)
    }
    if (assessment.installations.length > 0) {
      const adapter = inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform)
      if (adapter.problems.length > 0 || adapter.target === null || isNpxAdapterTarget(adapter.target) ||
          !hookAdapterTargetsArtifact(adapter.target, effective.artifact_path!) ||
          (adapter.target.kind !== 'native' && !sameLocalPath(adapter.target.execPath, process.execPath, deps.hookPlatform ?? process.platform))) {
        if (adapter.target?.kind === 'native') throw new Error('Repair the native installation before resuming integration')
        if (installHookAdapter({ execPath: process.execPath, scriptPath: effective.artifact_path! }, deps.hookAdapterHome,
          deps.hookPlatform, deps.env).changed) changed.push('hook-adapter')
      }
    }
    if (inventory.installed.length === 1) {
      let skillReport: { changed?: boolean; error?: string } = {}
      const skillResult = await updateSkillCommand({ ...repairDeps, io: { ...quietIo,
        out: (line: string) => { try { skillReport = JSON.parse(line) } catch { /* local status only */ } },
      } }, { json: true })
      if (skillResult !== EXIT.ok) {
        pending.push(skillReport.error ?? 'Skill refresh failed; resume through the native installer in the existing scope.')
        return report(false)
      }
      if (skillReport.changed === true) changed.push('skill')
    }
    for (const { installation, env } of assessment.installations) {
      if (installationFaults(installation, deps.hookPlatform).length === 0) continue
      const before = readFileSync(installation.file, 'utf8')
      if (hooksInstallCommand({ ...repairDeps, env }, { harness: installation.harness, narrate: false }) !== EXIT.ok) {
        pending.push(`Could not finish ${installation.harness} hook migration.`)
        return report(false)
      }
      if (readFileSync(installation.file, 'utf8') !== before) changed.push(`${installation.harness}-hooks`)
    }
    assessment = localIntegrationAssessment(deps)
    const repairFaults = assessment.faults.filter(fault => fault.code !== 'native-approval-pending')
    pending.push(...assessment.faults.map(fault => `${fault.code}: ${fault.remedy}`))
    if (owner !== null) {
      if (isHookInstallableHarness(owner.harness) && questionRoutingCapability(owner.harness, deps.hookPlatform).stopContinuation !== 'unsupported') {
        pending.push(...activeQuestionRouteProblems(deps, owner,
          assessment.installations.filter(entry => entry.env === deps.env).map(entry => entry.installation)))
      }
      if (changed.includes(`${owner.harness}-hooks`)) {
        pending.push('Changed hooks need exact-session activation verification; preserve the current Agent Session until a specific approval or fresh-session requirement is proven.')
      }
      if (owner.harness === 'codex' && owner.sessionId !== undefined && !codexToolHookReady(deps, owner.sessionId)) {
        pending.push(CODEX_TOOL_HOOK_RECOVERY)
      }
    }
    if (assessment.faults.length === 0) {
      attendants = await activateInstalledAttendants(deps, effective.artifact_path!)
      if (attendants.some(entry => entry.state === 'activated')) changed.push('resident-attendants')
      const unresolved = attendants.filter(entry => entry.state === 'pending' || !entry.native_activity)
      if (unresolved.length > 0) pending.push(`${unresolved.length} existing Codex session(s) still need native activity or resident activation verification; keep their Agent Sessions and pending inputs intact.`)
    }
    return report(repairFaults.length === 0)
  } catch {
    pending.push('Integration could not be verified; run notifai doctor --json and resume after the diagnosed gap is resolved.')
    return report(false)
  }
}
