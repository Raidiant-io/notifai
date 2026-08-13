import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-cli-tests-'))
const home = path.join(root, 'home')
const env = { ...process.env }

env.TMPDIR = root
env.TMP = root
env.TEMP = root
env.HOME = home
env.USERPROFILE = home
env.CLAUDE_CONFIG_DIR = path.join(home, '.claude')
env.CODEX_HOME = path.join(home, '.codex')
env.OPENCODE_CONFIG_DIR = path.join(home, '.config', 'opencode')
env.XDG_CONFIG_HOME = path.join(home, '.config')
env.XDG_STATE_HOME = path.join(home, '.local', 'state')
env.NOTIFAI_CREDENTIALS = 'file'
env.NOTIFAI_TEST_HOME = home

// A test process is not a child agent session. Ambient harness markers make
// product code inspect or mutate the account that launched the suite.
for (const key of Object.keys(env)) {
  if (
    key === 'CLAUDECODE' ||
    key.startsWith('CLAUDE_CODE_') ||
    key === 'CODEX_THREAD_ID' ||
    key === 'OPENCODE_SESSION_ID' ||
    key.startsWith('CURSOR_')
  ) {
    delete env[key]
  }
}

try {
  const vitest = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'))
  const forwarded = process.argv.slice(2)
  if (forwarded[0] === '--') forwarded.shift()
  const result = spawnSync(process.execPath, [vitest, 'run', ...forwarded], {
    cwd: fileURLToPath(new URL('../apps/cli', import.meta.url)),
    env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
