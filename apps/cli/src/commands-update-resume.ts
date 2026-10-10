/** Resume owned integration work using this installed package's authority. */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { EXIT, type CommandDeps } from './commands-core.js'
import { resolveActiveHarness } from './commands-harness-context.js'
import { activeQuestionRouteProblems } from './commands-hook-diagnostics.js'
import { hooksRefreshCommand } from './commands-hook-install.js'
import { installedSkillMatchesPackage, listScopedNotifaiSkills } from './commands-skill.js'
import { ownedSkillInventory, skillInventoryIssue } from './native-skills.js'
import { updateSkillCommand } from './commands-update-skill.js'
import { hookAdapterTargetsArtifact, inspectHookAdapter, installHookAdapter, isNpxAdapterTarget } from './hook-adapter.js'
import { pendingList, readSessionState } from './hook-session-state.js'
import { installationFaults, localIntegrationAssessment } from './integration-health.js'
import { packageVersion } from './release.js'
import { installedChangelog } from './update-handoff.js'
import { isSemVer } from './version.js'
import { isHookInstallableHarness, questionRoutingCapability } from './harnesses.js'
import { canonicalPath, sameLocalPath } from './local-path.js'
import { codexToolHookReady, CODEX_TOOL_HOOK_RECOVERY } from './codex-tool-messages.js'
import { integrationPublication } from './native-installation.js'
import { buildIdentity } from './distribution.js'
import { pendingHookRepairs, withHookRepairIntent } from './integration-repair.js'
import { pendingNpmRepairs } from './npm-repair-status.js'

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
  const diagnostics: string[] = []
  const report = (filesComplete: boolean): number => {
    const npmRepairs = pendingNpmRepairs(deps.env)
    if (npmRepairs.length) pending.push('A scoped npm repair remains pending; the responsible agent must resume its exact prepared operation after observing the approved pause.')
    const complete = filesComplete && pending.length === 0
    const result = { ok: filesComplete, read_only: false, running_version: packageVersion(),
      files_complete: filesComplete, migration_complete: complete, pending_actions: [...new Set(pending)],
      npm_repairs: npmRepairs,
      diagnostics: [...new Set(diagnostics)], changed, attendants: [],
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
    const publish = integrationPublication(deps)
    const setupPending = (file: string | undefined) => file !== undefined && (publish.pending?.() ?? []).some(item =>
      sameLocalPath(item.scope, canonicalPath(path.dirname(file)), deps.hookPlatform ?? process.platform))
    const native = buildIdentity() !== null
    let assessment = localIntegrationAssessment(deps)
    const coexistence = assessment.faults.find(fault => fault.code === 'legacy-native-coexistence')
    if (!native && coexistence !== undefined) {
      pending.push(`${coexistence.code}: ${coexistence.remedy}`)
      return report(false)
    }
    const effective = assessment.cli.effective
    // A command invoked through another prefix has no authority to retarget
    // shared integration or replace its guidance merely because it can run.
    if (!native && (effective?.artifact_path === null || effective === null ||
        !hookAdapterTargetsArtifact({ execPath: process.execPath, scriptPath: assessment.cli.current.artifact_path }, effective.artifact_path))) {
      pending.push('Resolve the effective installation before resuming integration; run notifai doctor --json.')
      return report(false)
    }
    const active = resolveActiveHarness(deps.env, deps.cwd, (deps.now ?? Date.now)())
    const owner = active.contested.length === 0 ? active.active : null
    const waiting = updateWorkPending(deps)
    if (!native && waiting !== null) {
      pending.push(waiting)
      return report(false)
    }
    const inventory = ownedSkillInventory(await listScopedNotifaiSkills(deps))
    const skillIssue = skillInventoryIssue(inventory)
    const integrationArtifact = native ? assessment.cli.current.artifact_path : effective?.artifact_path
    if (assessment.installations.length > 0) {
      const adapter = inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform)
      if (adapter.problems.length > 0 || adapter.target === null || isNpxAdapterTarget(adapter.target) ||
          !integrationArtifact || !hookAdapterTargetsArtifact(adapter.target, integrationArtifact) ||
          (adapter.target.kind !== 'native' && !sameLocalPath(adapter.target.execPath, process.execPath, deps.hookPlatform ?? process.platform))) {
        if (adapter.target?.kind === 'native') throw new Error('Repair the native installation before resuming integration')
        if (!integrationArtifact) throw new Error('Installed artifact is unavailable')
        if (publish(() => installHookAdapter({ execPath: process.execPath, scriptPath: integrationArtifact }, deps.hookAdapterHome,
          deps.hookPlatform, deps.env)).changed) changed.push('hook-adapter')
      }
    }
    if (skillIssue === null && inventory.installed.length === 1) {
      let skillReport: { changed?: boolean; error?: string } = {}
      const skillResult = await updateSkillCommand({ ...repairDeps, io: { ...quietIo,
        out: (line: string) => { try { skillReport = JSON.parse(line) } catch { /* local status only */ } },
      } }, { json: true }, publish)
      if (skillResult !== EXIT.ok) {
        pending.push(skillReport.error ?? 'Skill refresh failed; resume through the native installer in the existing scope.')
      }
      if (skillReport.changed === true) changed.push('skill')
    }
    for (const { installation, env } of assessment.installations) {
      if (setupPending(installation.file)) continue
      if (installationFaults(installation, deps.hookPlatform).length === 0) continue
      const before = readFileSync(installation.file, 'utf8')
      if (hooksRefreshCommand({ ...repairDeps, env }, installation.harness, (action, scope) => publish(() =>
        withHookRepairIntent({ ...deps, env }, installation, env === deps.env ? owner : null, action), scope)) !== EXIT.ok) {
        pending.push(`Could not finish ${installation.harness} hook migration.`)
        continue
      }
      if (!existsSync(installation.file) || readFileSync(installation.file, 'utf8') !== before) changed.push(`${installation.harness}-hooks`)
    }
    assessment = localIntegrationAssessment(deps)
    const after = ownedSkillInventory(await listScopedNotifaiSkills(deps))
    const afterIssue = skillInventoryIssue(after)
    const ownedSkillGap = afterIssue !== null || after.installed.some(skill => !installedSkillMatchesPackage(skill))
    if (ownedSkillGap) pending.push(afterIssue === null ? 'The refreshed owned guidance could not be verified.'
      : `${afterIssue.detail} ${afterIssue.remedy}`)
    // Unselected foreign guidance remains diagnosed, but has no authority over
    // independent owned hooks or resident recovery. Never hide an owned gap.
    const repairFaults = assessment.faults.filter(fault => fault.code === 'hooks-drift' && !setupPending(fault.file) ||
      (!native && fault.code === 'adapter-drift'))
    diagnostics.push(...assessment.faults.map(fault => `${fault.code}: ${fault.remedy}`))
    pending.push(...repairFaults.map(fault => `${fault.code}: ${fault.remedy}`))
    if (owner !== null) {
      if (isHookInstallableHarness(owner.harness) && questionRoutingCapability(owner.harness, deps.hookPlatform).stopContinuation !== 'unsupported') {
        const problems = activeQuestionRouteProblems(deps, owner,
          assessment.installations.filter(entry => entry.env === deps.env).map(entry => entry.installation))
        diagnostics.push(...problems)
      }
      if (owner.harness === 'codex' && owner.sessionId !== undefined && !codexToolHookReady(deps, owner.sessionId)) {
        diagnostics.push(CODEX_TOOL_HOOK_RECOVERY)
      }
    }
    // Fence even a no-write resume: another runtime may have activated while
    // asynchronous skill discovery was in flight. Resolve durable requirements
    // from a fresh synchronous inspection under that same authority.
    return publish(() => {
      pending.push(...pendingHookRepairs(deps, localIntegrationAssessment(deps).installations))
      // First-time host setup is not a failed runtime update. Keep its scope
      // visible without making unrelated owned repairs depend on its outcome.
      diagnostics.push(...(publish.pending?.() ?? []).map(item =>
        `Plugin setup remains pending at ${item.scope}; preserve its prepared source and confirm the original host installer has finished before repairing that scope.`))
      return report(!ownedSkillGap && repairFaults.length === 0)
    })
  } catch {
    pending.push('Integration could not be verified; run notifai doctor --json and resume after the diagnosed gap is resolved.')
    return report(false)
  }
}
