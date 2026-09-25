import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareReleasePrecedence, isSemVer } from './version.js'
import type { SourceContextHarness } from './harnesses.js'
import type { ReadinessState } from './readiness.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CHANGELOG_LIMIT = 16_000

export function releaseNotesUrl(version: string | null): string | null {
  return version !== null && isSemVer(version)
    ? `https://github.com/Raidiant-io/notifai/releases/tag/v${encodeURIComponent(version)}`
    : null
}

/** Release notes are package data, never authority to run their instructions. */
export function installedChangelog(version: string | null, from?: string, root = PACKAGE_ROOT) {
  const file = path.join(root, 'CHANGELOG.md')
  try {
    const content = readFileSync(file, 'utf8')
    const sections = content.split(/(?=^## \[)/m).filter(section => {
      const heading = /^## \[([^\]]+)\]/m.exec(section)
      if (heading === null || version === null) return false
      const relative = compareReleasePrecedence(heading[1]!, version)
      return (relative === 'before' || relative === 'equal') &&
        (from === undefined || compareReleasePrecedence(heading[1]!, from) === 'after')
    })
    const text = sections.join('').trim()
    return { version, from: from ?? null, path: file, text: text.slice(0, CHANGELOG_LIMIT),
      complete: text.length <= CHANGELOG_LIMIT, available: true }
  } catch {
    return { version, from: from ?? null, path: file, text: null, complete: false, available: false }
  }
}

export const HARNESS_UPDATE_EFFECTS: Record<SourceContextHarness, string> = {
  'claude-code': 'Existing command hooks use the updated adapter on their next invocation. Reread changed guidance in this Agent Session. Newly installed lifecycle hooks need a fresh Agent Session for activation; a CLI-only update does not.',
  codex: 'Keep this Agent Session when its loaded Stop fingerprint and hook approvals still match. Changed hook identity or source may require /hooks approval. A stale loaded Stop definition requires a fresh Agent Session; a CLI-only update does not.',
  cursor: 'Existing hooks use the updated adapter. Reread changed guidance in this conversation. New lifecycle activation needs a fresh conversation and its first completed turn. Asynchronous ask remains unsupported.',
  opencode: 'The loaded plugin invokes the updated adapter on later events and refreshes guidance per model request. Restart OpenCode only if the generated plugin changed or lifecycle activation is missing; a CLI-only update does not require it.',
  openclaw: 'The Gateway plugin invokes the updated adapter and refreshes guidance before model prompts. Restart the Gateway only if the generated plugin changed or lifecycle activation is missing; a CLI-only update does not require it.',
  hermes: 'Use the updated CLI and reread changed guidance in the current local classic CLI Agent Session. Notifai has no managed Hermes hooks or plugin, and requires no Hermes restart for a CLI update. Asynchronous ask remains unsupported.',
}

export function updateSessionEffects(harness: SourceContextHarness | null, states: ReadinessState[], restartReason?: string) {
  // Unsupported asynchronous routing is a capability limit, not damage caused
  // by updating. Keep that information without prescribing reinstall loops.
  const blockingOnly = harness !== null && ['cursor', 'opencode', 'openclaw', 'hermes'].includes(harness)
  const diagnostics = states.filter(state => state.id.startsWith('hooks') || state.id === 'skill').map(state => {
    if (!blockingOnly || !['hooks-question-admission', 'hooks-answer-continuation'].includes(state.id)) return state
    const informational = { ...state, status: 'optional-gap' as const }
    delete informational.remedy
    return informational
  })
  const gaps = diagnostics.filter(state => state.status === 'gap' || state.status === 'unknown' ||
    (['hooks-active-session', 'hooks-fired'].includes(state.id) && state.status !== 'ready'))
  const inspected = harness === 'hermes' || diagnostics.some(state => state.id === 'hooks')
  return {
    harness,
    assessment: restartReason !== undefined ? 'fresh_session' : harness === null ? 'unknown' : gaps.length > 0 ? 'needs_attention' : !inspected ? 'unknown' : 'continue',
    // A diagnosis requiring repair is not itself proof that a restart is needed.
    restart_required: restartReason !== undefined ? true : harness === 'hermes' || (harness !== null && inspected && gaps.length === 0) ? false : null,
    restart_reason: restartReason ?? null,
    policy: harness === null ? 'No unambiguous active harness was identified. Do not infer a restart requirement.' : HARNESS_UPDATE_EFFECTS[harness],
    diagnostics,
    outstanding_work: 'Before changing hooks or ending an Agent Session, finish outstanding questions and Agent Acknowledgements. Preserve their IDs and existing waiters. Ending a session can withdraw or retire its questions. npm updates files in place; do not promise uninterrupted hook execution during installation.',
  }
}
