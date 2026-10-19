/** Installed capability for card-sourced registration and foreground delivery. */
import type { CommandDeps } from './commands-core.js'
import { codexTrustProblems, findInstallations, handlerEvent } from './install-hooks.js'

export function codexCardHooksReady(deps: Pick<CommandDeps, 'env' | 'hookAdapterHome' | 'hookPlatform'>): boolean {
  const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform)
    .filter(installation => installation.harness === 'codex')
  if (installations.some(installation => (installation.problems ?? []).length > 0)) return false
  const hooks = installations.map(installation => ({ ...installation, handlers: installation.handlers.filter(handler =>
    ['pre-tool-use', 'post-tool-use', 'user-prompt-submit'].includes(handlerEvent(handler.command) ?? '')) }))
  const handlers = hooks.flatMap(installation => installation.handlers)
  if (handlers.length !== 3 || !['PreToolUse', 'PostToolUse', 'UserPromptSubmit'].every(event =>
    handlers.some(handler => handler.event === event && handler.async !== true && handler.asyncRewake !== true &&
      (handler.matcher === undefined || handler.matcher === '*' ||
        (event === 'PreToolUse' && handler.matcher === 'request_user_input_async'))))) return false
  return codexTrustProblems(hooks, deps.env).length === 0
}
