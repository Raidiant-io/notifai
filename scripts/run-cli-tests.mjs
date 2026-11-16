import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The first skill file whose bytes differ between skills/notifai and the
 * bundle a build copies into apps/cli/dist, or null when they match. Init and
 * migration tests install that bundle; a stale one fails them with a
 * misleading skill gap instead of naming the missing build.
 */
function staleSkillBundle(repository) {
  const source = path.join(repository, 'skills', 'notifai')
  if (!existsSync(source)) return null
  const bundle = path.join(repository, 'apps', 'cli', 'dist', 'skill-source', 'notifai')
  const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort()
  if (!existsSync(bundle)) return 'skills/notifai'
  const wanted = files(source)
  const built = files(bundle)
  const extra = built.find((file) => !wanted.includes(file))
  if (extra !== undefined) return path.join('skills/notifai', extra)
  return wanted.map((file) => path.join('skills/notifai', file)).find((file, index) =>
    !existsSync(path.join(bundle, wanted[index])) ||
    !readFileSync(path.join(source, wanted[index])).equals(readFileSync(path.join(bundle, wanted[index])))) ?? null
}

const stale = staleSkillBundle(fileURLToPath(new URL('..', import.meta.url)))
if (stale !== null) {
  console.error(`apps/cli/dist holds an older skill bundle than ${stale}. ` +
    'Build first with `pnpm --filter @raidiant/notifai build`, or run `pnpm --filter @raidiant/notifai test`, which builds.')
  process.exit(2)
}

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
env.GROK_HOME = path.join(home, '.grok')
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
    key.startsWith('CURSOR_') ||
    key === 'GROK_SESSION_ID' ||
    key === 'GROK_HOOK_EVENT' ||
    key === 'GROK_LEADER_SOCKET' ||
    key.startsWith('HERMES_SESSION_') ||
    key.startsWith('OPENCLAW_') ||
    key.startsWith('NOTIFAI_ACTIVE_')
  ) {
    delete env[key]
  }
}

const signals = ['SIGINT', 'SIGTERM']
let child
let forwardedSignal

try {
  const cliPackage = new URL('../apps/cli/package.json', import.meta.url)
  const vitestPackage = createRequire(cliPackage).resolve('vitest/package.json')
  const { bin } = JSON.parse(readFileSync(vitestPackage, 'utf8'))
  const vitest = path.resolve(path.dirname(vitestPackage), bin.vitest)
  const forwarded = process.argv.slice(2)
  if (forwarded[0] === '--') forwarded.shift()
  child = spawn(process.execPath, [vitest, 'run', ...forwarded], {
    cwd: fileURLToPath(new URL('../apps/cli', import.meta.url)),
    env,
    stdio: 'inherit',
  })
  for (const signal of signals) {
    process.once(signal, () => {
      forwardedSignal = signal
      child.kill(signal)
    })
  }
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (forwardedSignal !== undefined || result.signal !== null) {
    process.exitCode = 128 + (os.constants.signals[forwardedSignal ?? result.signal] ?? 0)
  } else {
    process.exitCode = result.code ?? 1
  }
} finally {
  for (const signal of signals) process.removeAllListeners(signal)
  rmSync(root, { recursive: true, force: true })
}
