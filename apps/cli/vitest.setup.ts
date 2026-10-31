import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import type * as AgentDetection from './src/agent-app-detection.js'

// Presence discovery also searches fixed system install locations. Never let
// the developer's installed apps select integrations in disposable-account tests.
// Pure candidate tests can still supply an explicit filesystem predicate.
vi.mock('./src/agent-app-detection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentDetection>()
  return { ...actual, detectAgentApps: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
    runnable?: (file: string) => boolean) => actual.detectAgentApps(env, platform,
      runnable ?? (file => file.startsWith(`${os.tmpdir()}${path.sep}`) && actual.runnableAgentFile(file, platform))) }
})

/**
 * Fail closed if the CLI suite was started without its disposable account.
 *
 * Hook discovery deliberately falls back to machine-global harness settings.
 * One missed fixture override must therefore abort the suite, not expose the
 * account that launched it. `scripts/run-cli-tests.mjs` owns creation and
 * teardown of this account before Vitest or any product module is evaluated.
 */
const home = process.env['NOTIFAI_TEST_HOME']
if (home === undefined || home === '') {
  throw new Error('CLI tests must run through scripts/run-cli-tests.mjs')
}
if (process.env['HOME'] !== home || os.homedir() !== home) {
  throw new Error('CLI tests are not isolated from the account home')
}
if (process.env['CODEX_HOME'] !== path.join(home, '.codex')) {
  throw new Error('CLI tests are not isolated from the Codex home')
}
