import { HOOK_INSTALLABLE_HARNESSES } from './harnesses.js'
import type { CommandDeps } from './commands-core.js'
import { detectedHarnesses, findInstallations } from './install-hooks.js'
import { skillInventory } from './commands-skill.js'
import type { ReadinessState } from './readiness.js'

// Machine setup only. A running Agent Session, its first prompt and Question
// Routing evidence have their own lifecycle and cannot make setup incomplete.
const SETUP_CHECKS = new Set([
  'hooks-stale', 'hooks-adapter', 'hooks-trust', 'hooks-stop-shape',
  'claude-code-hook-form', 'hooks-obsolete-native-plugin', 'hooks-codex-representation', 'hooks-openclaw-plugin', 'hooks-opencode-plugin', 'hooks-hermes-plugin',
])

export function agentAppsReport(deps: CommandDeps, states: readonly ReadinessState[]) {
  const detected = new Set(detectedHarnesses(deps.env, deps.hookPlatform))
  const installed = new Set(findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform).map(item => item.harness))
  const inventory = skillInventory(deps)
  return {
    supported_ids: [...HOOK_INSTALLABLE_HARNESSES],
    apps: HOOK_INSTALLABLE_HARNESSES.map(id => {
      const gaps: { id: string; detail: string; remedy?: ReadinessState['remedy'] }[] = []
      if (!installed.has(id)) gaps.push({ id: 'hooks-missing', detail: 'Notifai hooks are not installed',
        remedy: { by: 'cli', summary: 'install Notifai hooks', command: `notifai hooks install --harness ${id}` } })
      else for (const state of states) {
        if (SETUP_CHECKS.has(state.id) && state.status !== 'ready' &&
          (state.harnesses === undefined || state.harnesses.includes(id))) {
          gaps.push({ id: state.id, detail: state.detail, ...(state.remedy ? { remedy: state.remedy } : {}) })
        }
      }
      const copies = inventory.copies.filter(copy => copy.harnesses.includes(id))
      if (inventory.expectedDigest === null || inventory.error !== undefined || copies.length === 0 || copies.some(copy => copy.condition !== 'current')) {
        gaps.push({ id: 'skill', detail: inventory.expectedDigest === null || inventory.error !== undefined
          ? 'Current guidance could not be verified' : copies.length === 0
            ? 'This agent app does not load the Notifai skill' : 'This agent app loads outdated or unreadable Notifai guidance',
          remedy: { by: 'cli', summary: 'install current guidance for this agent app', command: `notifai init --skills --skills-scope global --skills-harness ${id}` } })
      }
      return { id, supported: true as const, detected: detected.has(id), connected: gaps.length === 0, gaps }
    }),
  }
}
