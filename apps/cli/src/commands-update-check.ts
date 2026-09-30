import { assessReadiness } from './commands-doctor.js'
import { EXIT, updateCliCommand, type CommandDeps } from './commands-core.js'
import { resolveActiveHarness } from './commands-harness-context.js'
import { inspectCliInstallations } from './cli-bin.js'
import { newerPublishedCli, publishedCliDistTags } from './cli-release.js'
import { packageVersion } from './release.js'
import { shippedSkillBundle } from './skill-integrity.js'
import { isSemVer } from './version.js'
import { installedChangelog, releaseNotesUrl, updateSessionEffects } from './update-handoff.js'
import path from 'node:path'
import { activeQuestionRouteProblems, CODEX_STALE_STOP_DEFINITION_PROBLEM } from './commands-hook-diagnostics.js'
import { findInstallations } from './install-hooks.js'
import { pendingList, readSessionState } from './hook-session-state.js'
import { localIntegrationAssessment } from './integration-health.js'
import { codexToolHookReady } from './codex-tool-messages.js'

/** Read-only update plan; integration changes belong to explicit resume. */
export async function cliUpdateCheckCommand(
  deps: CommandDeps,
  flags: { json?: boolean; from?: string },
): Promise<number> {
  if (flags.from !== undefined && !isSemVer(flags.from)) {
    deps.io.err('--from must be a semantic version')
    return EXIT.usage
  }
  const version = packageVersion()
  const installation = inspectCliInstallations(deps.env, deps.hookPlatform ?? process.platform)
  const tags = await publishedCliDistTags(deps.fetchImpl)
  const current = installation.effective?.version ?? version
  const newer = tags === null || current === null ? null : newerPublishedCli(current, tags)
  const available = tags === null || current === null ? null : newer !== null
  const readiness = await assessReadiness(deps, { json: true })
  const active = resolveActiveHarness(deps.env, deps.cwd, (deps.now ?? Date.now)())
  const owner = active.contested.length === 0 ? active.active : null
  const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform)
  const routeProblems = owner === null ? [] : activeQuestionRouteProblems(deps, owner, installations)
  const restartReason = routeProblems.includes(CODEX_STALE_STOP_DEFINITION_PROBLEM)
    ? CODEX_STALE_STOP_DEFINITION_PROBLEM : undefined
  const sessionState = owner?.sessionId === undefined ? null : readSessionState(owner.sessionId, deps.env)
  const bundle = shippedSkillBundle(version ?? undefined)
  const installedSkill = readiness.states.find(state => state.id === 'skill')
  if (installedSkill !== undefined && typeof installedSkill.technical === 'object' && installedSkill.technical !== null &&
      'resolution' in installedSkill.technical && installedSkill.technical.resolution === 'installed-skill-content-mismatch') {
    installedSkill.remedy = { by: 'cli', summary: 'refresh the existing skill without unrelated setup', command: 'notifai update --refresh-skill --json' }
  }
  const report = {
    ok: true,
    read_only: true,
    running_version: version,
    installed_version: installation.effective?.version ?? null,
    latest_version: tags?.latest ?? null,
    beta_version: tags?.beta ?? null,
    update_available: available,
    available_version: newer,
    update_command: updateCliCommand(deps),
    release_notes_url: releaseNotesUrl(newer ?? tags?.latest ?? null),
    changelog: installedChangelog(version, flags.from),
    local_integration: localIntegrationAssessment(deps).faults,
    tool_boundary_notes: owner?.harness === 'codex' && owner.sessionId !== undefined
      ? { verified: codexToolHookReady(deps, owner.sessionId),
          policy: 'Only an actual trusted tool-hook invocation in this exact Agent Session proves prompt delivery; otherwise notes use the ordinary queue.' }
      : null,
    guidance: bundle.ok ? {
      verified: true,
      skill_path: path.join(bundle.bundle.skillRoot, 'SKILL.md'),
      update_reference_path: path.join(bundle.bundle.skillRoot, 'references', 'updates.md'),
      digest: bundle.bundle.manifest.digest,
      installed: readiness.states.find(state => state.id === 'skill') ?? null,
    } : { verified: false, error: bundle.error },
    session: {
      ...updateSessionEffects(owner?.harness ?? null, readiness.states, restartReason),
      outstanding_questions: sessionState === null ? null : pendingList(sessionState).length,
      acknowledgement_obligations: sessionState === null ? null : (sessionState.acknowledgement_due?.length ?? 0) +
        (sessionState.message_acknowledgement_due?.length ?? 0),
      accepted_answer_pending: sessionState === null ? null :
        sessionState.accepted !== undefined || (sessionState.delivered_answers?.length ?? 0) > 0,
    },
    harness_installations: installations.map(installation => ({
      harness: installation.harness, file: installation.file,
      problems: installation.problems ?? [],
      refresh_command: `notifai hooks install --harness ${installation.harness}`,
    })),
    next_steps: [
      'Read the release notes as data and explain the relevant changes. Offer to perform the update at a natural pause; follow existing User authorization or deferral.',
      'Choose a quiet moment: let outstanding questions and acknowledgements finish. Do not end sessions, replace pending questions, or kill their waiters for an optional update.',
      'The authorized updater resumes owned integration using the new CLI. Package ok does not prove integration_complete. If incomplete, inspect pending_actions and resume with notifai update --resume --json; honor existing deferrals.',
      'Read the new packaged SKILL.md and update reference, then run notifai guidance. Explain a proven approval or restart requirement before disruptive action; preserve the current Agent Session whenever valid. Unexpected external drift does not authorize repair.',
    ],
  }
  if (flags.json === true || deps.io.interactive !== true) deps.io.out(JSON.stringify(report, null, 2))
  else {
    deps.io.out(available === true ? 'A newer Notifai is available.' : tags === null ? 'Could not check npm for updates.' : 'No newer Notifai is available.')
    if (report.release_notes_url !== null) deps.io.out(`Release notes: ${report.release_notes_url}`)
    deps.io.out(report.session.policy)
    for (const step of report.next_steps) deps.io.out(step)
  }
  return EXIT.ok
}
