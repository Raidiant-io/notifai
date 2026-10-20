/**
 * One hook's scope, when the hub runs the hook in its own process (see
 * `hub-ingress.ts`). A runtime started for one hook is that scope by itself:
 * its environment is the hook's and everything it learns lives as long as the
 * hook. The hub runs many hooks at once, so it carries the same two things per
 * hook explicitly: the hook's environment, for the programs a hook starts, and
 * answers that cannot change within one hook, so it asks each question once.
 * Outside a hook scope nothing is remembered and the process's own
 * environment applies, exactly as before.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface HookScope {
  env: NodeJS.ProcessEnv
  answers: Map<string, unknown>
}

const scopes = new AsyncLocalStorage<HookScope>()

/** Run one hook's work with its own environment and one answer per question. */
export function inHookScope<T>(env: NodeJS.ProcessEnv, work: () => Promise<T>): Promise<T> {
  return scopes.run({ env, answers: new Map() }, work)
}

/** The running hook's environment, or undefined outside a hook scope. */
export function hookScopeEnv(): NodeJS.ProcessEnv | undefined {
  return scopes.getStore()?.env
}

/** `compute()` once per hook for this key; every time outside a hook scope. */
export function oncePerHook<T>(key: string, compute: () => T): T {
  const scope = scopes.getStore()
  if (scope === undefined) return compute()
  if (scope.answers.has(key)) return scope.answers.get(key) as T
  const value = compute()
  scope.answers.set(key, value)
  return value
}
