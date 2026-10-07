import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ShellPathInstallation, userCommandDirectory } from './installation-path.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(shell = '/bin/zsh', env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }) {
  const home = mkdtempSync(path.join(os.tmpdir(), "notifai-shell's path-")); roots.push(home)
  const bin = path.join(home, '.notifai', 'bin'); mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'notifai'), '#!/bin/sh\necho installed-notifai\n', { mode: 0o755 })
  const directory = path.join(home, '.local', 'bin'), command = path.join(directory, 'notifai')
  const state: { receipt: unknown } = { receipt: null }
  const make = (overrides: Partial<ConstructorParameters<typeof ShellPathInstallation>[0]> = {}) =>
    new ShellPathInstallation({ home, bin, shell, env: { HOME: home, ...env }, read: () => state.receipt,
      save: value => { state.receipt = JSON.parse(JSON.stringify(value)) }, ...overrides })
  return { home, bin, directory, command, state, make, installation: make() }
}
const posix = it.skipIf(process.platform === 'win32')

it('names the XDG User command directory, honouring only an absolute XDG_BIN_HOME', () => {
  expect(userCommandDirectory('/home/u', {})).toBe(path.join('/home/u', '.local', 'bin'))
  expect(userCommandDirectory('/home/u', { XDG_BIN_HOME: '/opt/u/bin' })).toBe('/opt/u/bin')
  expect(userCommandDirectory('/home/u', { XDG_BIN_HOME: 'relative/bin' })).toBe(path.join('/home/u', '.local', 'bin'))
})

posix('links the command into a directory the shell already searches and edits no startup file', () => {
  const f = fixture('/usr/bin/fish')
  const searched = f.make({ env: { HOME: f.home, PATH: `${path.join(f.home, '.local', 'bin')}:/usr/bin` } })
  expect(searched.configure()).toMatchObject({ ok: true, changed: true, command: f.command, on_path: true, profiles: [] })
  expect(readlinkSync(f.command)).toBe(path.join(f.bin, 'notifai'))
  expect(existsSync(path.join(f.home, '.zshrc'))).toBe(false)
  expect(existsSync(path.join(f.home, '.config'))).toBe(false)
  expect(searched.configure().changed).toBe(false)
  expect(searched.remove()).toMatchObject({ ok: true, changed: true })
  expect(existsSync(f.command)).toBe(false)
})

posix('adds the command directory to the login shell only when it is not searched, and removes only its own block', () => {
  const f = fixture()
  const profile = path.join(f.home, '.zshrc')
  writeFileSync(profile, '# existing User content\nexport MY_VALUE=hello\n')
  expect(f.installation.configure()).toMatchObject({ ok: true, on_path: false, profiles: ['.zshrc', '.zprofile'] })
  const installed = readFileSync(profile, 'utf8')
  expect(installed).toContain("/.local/bin'")
  expect(installed).not.toContain('/.notifai/bin')
  expect(f.installation.configure().changed).toBe(false)
  writeFileSync(profile, `${installed}# another User edit\n`)
  expect(f.installation.remove().ok).toBe(true)
  expect(readFileSync(profile, 'utf8')).toBe('# existing User content\nexport MY_VALUE=hello\n# another User edit\n')
  expect(existsSync(f.command)).toBe(false)
})

posix('reaches the installed command from a fresh Bash login, preserving its chosen login file', () => {
  const f = fixture('/bin/bash')
  const login = path.join(f.home, '.bash_login')
  writeFileSync(login, '# preserve chosen login file\n')
  expect(f.installation.configure()).toMatchObject({ ok: true, profiles: ['.bashrc', '.bash_login'] })
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', '. "$HOME/.bashrc"; . "$HOME/.bash_login"; printf "%s|" "$PATH"; notifai'], {
    env: { HOME: f.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000,
  })
  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${f.directory}:/usr/bin:/bin|installed-notifai\n`)
  expect(readFileSync(login, 'utf8')).toContain('# preserve chosen login file\n')
})

posix('gives fish its own owned conf.d file', () => {
  const f = fixture('/opt/homebrew/bin/fish')
  expect(f.installation.configure()).toMatchObject({ ok: true, profiles: ['.config/fish/conf.d/notifai.fish'] })
  const file = path.join(f.home, '.config/fish/conf.d/notifai.fish')
  expect(readFileSync(file, 'utf8')).toContain(`set -gx PATH '${f.directory.replaceAll("'", "\\'")}' $PATH`)
  const fish = spawnSync('fish', ['--no-config', '-c', `source '${file.replaceAll("'", "\\'")}'; notifai`], {
    env: { HOME: f.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000,
  })
  if (fish.error === undefined) expect(fish.stdout).toBe('installed-notifai\n')
  expect(f.installation.remove().ok).toBe(true)
  expect(existsSync(file)).toBe(false)
})

posix('tells any other shell the one line to add, without failing or touching startup files', () => {
  for (const [shell, env] of [['/usr/bin/nu', {}], ['/bin/zsh', { ZDOTDIR: '/elsewhere' }]] as const) {
    const f = fixture(shell, { PATH: '/usr/bin:/bin', ...env })
    const result = f.installation.configure()
    expect(result).toMatchObject({ ok: true, command: f.command, on_path: false, profiles: [], conflicts: [] })
    expect(result.manual).toContain(f.directory)
    expect(existsSync(path.join(f.home, '.zshrc'))).toBe(false)
  }
})

posix('never replaces another program\'s notifai command, and keeps a User-replaced entry on removal', () => {
  const f = fixture()
  mkdirSync(f.directory, { recursive: true })
  symlinkSync('/somewhere/else/notifai', f.command)
  expect(f.installation.configure()).toMatchObject({ ok: false, command: null, conflicts: [f.command] })
  expect(readlinkSync(f.command)).toBe('/somewhere/else/notifai')

  const g = fixture()
  expect(g.installation.configure().ok).toBe(true)
  rmSync(g.command)
  writeFileSync(g.command, '#!/bin/sh\necho mine\n', { mode: 0o755 })
  expect(g.installation.remove()).toMatchObject({ ok: false, conflicts: [g.command] })
  expect(lstatSync(g.command).isFile()).toBe(true)
})

posix('preserves a User-edited owned PATH block and reports incomplete removal', () => {
  const f = fixture()
  f.installation.configure()
  const profile = path.join(f.home, '.zshrc')
  const edited = readFileSync(profile, 'utf8').replace('case ', '# User customization\ncase ')
  writeFileSync(profile, edited)
  expect(f.installation.remove()).toMatchObject({ ok: false, conflicts: ['.zshrc'] })
  expect(readFileSync(profile, 'utf8')).toBe(edited)
})

posix('resumes after profile publication with a pending ownership receipt without duplicating the block', () => {
  const f = fixture()
  let writes = 0, interrupted = true
  const installation = f.make({ save: value => {
    if (++writes > 3 && interrupted) throw new Error('storage interrupted')
    f.state.receipt = JSON.parse(JSON.stringify(value))
  } })
  expect(installation.configure().ok).toBe(false)
  const before = readFileSync(path.join(f.home, '.zshrc'), 'utf8')
  interrupted = false
  expect(installation.configure().ok).toBe(true)
  expect(readFileSync(path.join(f.home, '.zshrc'), 'utf8')).toBe(before)
  expect(installation.remove().ok).toBe(true)
})
