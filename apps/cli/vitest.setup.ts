import os from 'node:os'
import path from 'node:path'

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
