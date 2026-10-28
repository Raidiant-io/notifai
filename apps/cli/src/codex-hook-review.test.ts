import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { CodexHookMetadata } from './codex-hooks-list.js'
import {
  codexReviewHomes,
  codexReviewLaunch,
  doctorCodexCommand,
  findCodexExecutable,
  rememberCodexHome,
  type CodexReviewLaunch,
} from './codex-hook-review.js'
import type { CommandDeps } from './commands-core.js'
import { codexHookIdentityHash, type Installation } from './install-hooks.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A scratch account: `~/.codex`, a T3-style shadow linking its config, an Orca account and a retired home. */
function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-review-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const main = path.join(home, '.codex')
  mkdirSync(main, { recursive: true })
  writeFileSync(path.join(main, 'config.toml'), '[features]\nhooks = true\n')
  writeFileSync(path.join(main, 'hooks.json'), '{}\n')
  writeFileSync(path.join(main, 'auth.json'), '{}\n')
  const shadow = path.join(home, '.t3', 'userdata', 'providers', 'codex', 'codex_1', 'shadow')
  mkdirSync(shadow, { recursive: true })
  symlinkSync(path.join(main, 'config.toml'), path.join(shadow, 'config.toml'))
  symlinkSync(path.join(main, 'hooks.json'), path.join(shadow, 'hooks.json'))
  const orca = path.join(home, 'Library', 'Application Support', 'orca', 'codex-accounts', 'a1', 'home')
  mkdirSync(orca, { recursive: true })
  writeFileSync(path.join(orca, 'config.toml'), '')
  const state = path.join(root, 'state')
  const sessions = path.join(state, 'notifai', 'sessions')
  mkdirSync(sessions, { recursive: true })
  const attended = (id: string, codexHome: string) =>
    writeFileSync(path.join(sessions, `${id}.attendance.json`), JSON.stringify({ session_id: id, adoption: { codex_home: codexHome } }))
  attended('s1', shadow)
  attended('s2', orca)
  attended('s3', path.join(root, 'retired', 'home'))
  attended('s4', shadow)
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, XDG_STATE_HOME: state, PATH: '' }
  return { root, home, main, shadow, orca, env }
}

function handlers(file: string): Installation {
  const handler = (event: string, role: string) => ({ event, groupIndex: 0, handlerIndex: 0, command: `/x/notifai hook ${role} --harness codex`, timeout: 5 })
  return { harness: 'codex', file, handlers: [handler('Stop', 'stop'), handler('SessionStart', 'session-start')] }
}

function rows(installation: Installation, trustStatus: string, enabled = true): CodexHookMetadata[] {
  return installation.handlers.map((handler) => {
    const event = handler.event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    return { key: `${installation.file}:${event}:0:0`, eventName: handler.event.charAt(0).toLowerCase() + handler.event.slice(1),
      sourcePath: installation.file, enabled, currentHash: codexHookIdentityHash(handler), trustStatus }
  })
}

class Io {
  lines: string[] = []
  interactive = true
  confirmations = 0
  out(line: string) { this.lines.push(line) }
  err(line: string) { this.lines.push(line) }
  async confirm(_question: string, fallback = false) { this.confirmations += 1; return fallback }
  openUrl() { /* unused */ }
}

/**
 * Deps whose Codex answers from `trust` (home → status), which the fake
 * launcher can change, as the User approving in Codex's own screen would.
 */
function deps(s: ReturnType<typeof scratch>, trust: Map<string, string>, options: { interactive?: boolean; codexPath?: string | null; env?: NodeJS.ProcessEnv } = {}) {
  const io = new Io()
  io.interactive = options.interactive ?? true
  const launches: CodexReviewLaunch[] = []
  const installation = (env: NodeJS.ProcessEnv) => handlers(path.join(env['CODEX_HOME'] ?? s.main, 'hooks.json'))
  const value = {
    io,
    env: options.env ?? s.env,
    cwd: s.root,
    hookPlatform: 'darwin',
    codexHooksList: async (env: NodeJS.ProcessEnv) => rows(installation(env), trust.get(env['CODEX_HOME'] ?? s.main) ?? 'untrusted'),
    codexReview: {
      codexPath: options.codexPath === undefined ? '/usr/local/bin/codex' : options.codexPath,
      installations: (env: NodeJS.ProcessEnv) => [installation(env)],
      launch: async (launch: CodexReviewLaunch) => {
        launches.push(launch)
        // The User chooses "Trust all and continue" in Codex's screen.
        trust.set(launch.codexHome ?? s.main, 'trusted')
        return 'exited' as const
      },
    },
  } as unknown as CommandDeps
  return { deps: value, io, launches }
}

/** Every file's bytes and link-ness under `dir`. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const file = path.join(current, name)
      const link = lstatSync(file).isSymbolicLink()
      if (!link && statSync(file).isDirectory()) { walk(file); continue }
      out[path.relative(dir, file)] = `${link ? 'link:' : ''}${readFileSync(file, 'utf8')}`
    }
  }
  walk(dir)
  return out
}

it("finds ~/.codex, this shell's CODEX_HOME and the homes Notifai saw threads run in, never a missing one", () => {
  const s = scratch()
  const own = path.join(s.root, 'work-codex')
  mkdirSync(own)
  writeFileSync(path.join(own, 'config.toml'), '')
  const homes = codexReviewHomes({ ...s.env, CODEX_HOME: own }, 'darwin')
  expect(homes.map((home) => [home.home, home.origin, home.host])).toEqual([
    [s.main, 'default', null],
    [own, 'shell', null],
    [s.shadow, 'seen', 't3'],
    [s.orca, 'seen', 'orca'],
  ])
})

it('remembers the separate home a reminder named, so a fresh terminal finds it', () => {
  const s = scratch()
  const own = path.join(s.root, 'work-codex')
  mkdirSync(own)
  writeFileSync(path.join(own, 'hooks.json'), '{}')
  rememberCodexHome({ ...s.env, CODEX_HOME: own }, 'darwin')
  rememberCodexHome(s.env, 'darwin')
  expect(codexReviewHomes(s.env, 'darwin').map((home) => home.home)).toContain(own)
})

it('opens plain codex where the home has its own sign-in, and needs no sign-in where it has none', () => {
  expect(codexReviewLaunch({ home: '/h/.codex', isDefault: true }, true, 'darwin'))
    .toEqual({ home: '/h/.codex', args: [], codexHome: undefined, display: 'codex' })
  expect(codexReviewLaunch({ home: '/h/shadow', isDefault: false }, false, 'darwin'))
    .toEqual({ home: '/h/shadow', args: ['-c', 'model_provider=ollama'], codexHome: '/h/shadow', display: 'CODEX_HOME=/h/shadow codex -c model_provider=ollama' })
  expect(codexReviewLaunch({ home: 'C:\\Users\\o\'k\\shadow', isDefault: false }, false, 'win32').display)
    .toBe("$env:CODEX_HOME='C:\\Users\\o''k\\shadow'; codex -c model_provider=ollama; Remove-Item Env:CODEX_HOME")
})

it("opens Codex's own review in each home that waits, writes nothing itself, and reports the result", async () => {
  const s = scratch()
  const trust = new Map([[s.main, 'trusted'], [s.shadow, 'untrusted']])
  const { deps: d, io, launches } = deps(s, trust)
  const before = snapshot(s.root)
  expect(await doctorCodexCommand(d)).toBe(0)
  // Codex's screen is the only thing that approves: Notifai passes no trust and writes no file.
  expect(launches).toEqual([{ home: s.shadow, args: ['-c', 'model_provider=ollama'], codexHome: s.shadow, display: expect.any(String) }])
  expect(launches.flatMap((launch) => launch.args).join(' ')).not.toMatch(/hooks|trust/)
  expect(snapshot(s.root)).toEqual(before)
  expect(lstatSync(path.join(s.shadow, 'config.toml')).isSymbolicLink()).toBe(true)
  expect(io.lines.join('\n')).toContain(`✓ T3 Code account (~/.t3/userdata/providers/codex/codex_1/shadow): approved`)
  expect(io.lines.join('\n')).toMatch(/Orca's Codex accounts take their approval from ~\/\.codex/)
})

it('says so and launches nothing when every home is approved', async () => {
  const s = scratch()
  const { deps: d, io, launches } = deps(s, new Map([[s.main, 'trusted'], [s.shadow, 'trusted']]))
  expect(await doctorCodexCommand(d)).toBe(0)
  expect(launches).toEqual([])
  expect(io.confirmations).toBe(0)
  expect(io.lines[0]).toMatch(/^Notifai's hooks are approved in every Codex home Notifai knows/)
})

it('run by an agent, prints only the one command for the User and launches nothing', async () => {
  const s = scratch()
  for (const run of [{ interactive: false }, { env: { ...scratch().env, CODEX_THREAD_ID: 'thread-1' } }]) {
    const { deps: d, io, launches } = deps(s, new Map([[s.main, 'trusted']]), { ...run, ...(run.env ? { env: { ...s.env, CODEX_THREAD_ID: 'thread-1' } } : {}) })
    expect(await doctorCodexCommand(d)).toBe(1)
    expect(launches).toEqual([])
    expect(io.confirmations).toBe(0)
    expect(io.lines).toEqual([
      'T3 Code account (~/.t3/userdata/providers/codex/codex_1/shadow): 2 Notifai hooks new or changed',
      "Notifai's hooks wait for the User's approval in one Codex home. The User approves them: ask them to run `notifai doctor codex` in a terminal on this machine. It opens Codex's own hook review in each home; never approve hooks for them.",
    ])
  }
})

it('tells hooks that are off from hooks that wait: the startup screen lists only new and changed ones', async () => {
  const s = scratch()
  const { deps: d, io } = deps(s, new Map([[s.main, 'trusted']]))
  d.codexHooksList = async (env) => rows(handlers(path.join(env['CODEX_HOME'] ?? s.main, 'hooks.json')), 'trusted', env['CODEX_HOME'] === undefined)
  d.codexReview = { ...d.codexReview, launch: async () => 'exited' }
  expect(await doctorCodexCommand(d)).toBe(1)
  expect(io.lines.join('\n')).toContain("type /hooks, turn Notifai's hooks on and approve them")
  expect(io.lines.join('\n')).toContain('2 Notifai hooks turned off')
})

it('without the Codex CLI, launches nothing and names the step that still works', async () => {
  const s = scratch()
  const { deps: d, io, launches } = deps(s, new Map([[s.shadow, 'trusted']]), { codexPath: null })
  // No Codex to ask: trust comes from config.toml, which holds no approvals here.
  expect(await doctorCodexCommand(d)).toBe(1)
  expect(launches).toEqual([])
  const text = io.lines.join('\n')
  expect(text).toContain("The Codex CLI isn't installed")
  expect(text).toContain('click the Review hooks icon')
  expect(text).toContain('Install the Codex CLI (npm install -g @openai/codex), then run notifai doctor codex again.')
})

it('finds codex on PATH, with Windows extensions', () => {
  const s = scratch()
  const bin = path.join(s.root, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'codex.cmd'), '')
  expect(findCodexExecutable({ PATH: bin }, 'darwin')).toBeNull()
  expect(findCodexExecutable({ Path: bin, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(path.join(bin, 'codex.cmd'))
})
