import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ShellPathInstallation } from './installation-path.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(shell = '/bin/zsh') {
  const home = mkdtempSync(path.join(os.tmpdir(), "notifai-shell's path-")); roots.push(home)
  const bin = path.join(home, '.notifai', 'bin'); mkdirSync(bin, { recursive: true })
  let receipt: unknown = null
  const installation = new ShellPathInstallation({ home, bin, shell, read: () => receipt, save: value => { receipt = JSON.parse(JSON.stringify(value)) } })
  return { home, bin, installation }
}
it.skipIf(process.platform === 'win32')('owns only its shell PATH blocks and preserves unrelated User edits on removal', () => {
  const f = fixture()
  const profile = path.join(f.home, '.zshrc')
  writeFileSync(profile, '# existing User content\nexport MY_VALUE=hello\n')
  expect(f.installation.configure().ok).toBe(true)
  const installed = readFileSync(profile, 'utf8')
  expect(f.installation.configure().changed).toBe(false)
  writeFileSync(profile, `${installed}# another User edit\n`)
  expect(f.installation.remove().ok).toBe(true)
  expect(readFileSync(profile, 'utf8')).toBe('# existing User content\nexport MY_VALUE=hello\n# another User edit\n')
})
it.skipIf(process.platform === 'win32')('preserves a User-edited owned PATH block and reports incomplete removal', () => {
  const f = fixture()
  f.installation.configure()
  const profile = path.join(f.home, '.zshrc')
  const edited = readFileSync(profile, 'utf8').replace('case ', '# User customization\ncase ')
  writeFileSync(profile, edited)
  expect(f.installation.remove()).toMatchObject({ ok: false, conflicts: ['.zshrc'] })
  expect(readFileSync(profile, 'utf8')).toBe(edited)
})

it.skipIf(process.platform === 'win32')('supports quoted directories, repeated shell startup, and existing Bash login selection', () => {
  const f = fixture('/bin/bash')
  const login = path.join(f.home, '.bash_login')
  writeFileSync(login, '# preserve chosen login file\n')
  expect(f.installation.configure()).toMatchObject({ ok: true, profiles: ['.bashrc', '.bash_login'] })
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', '. "$HOME/.bashrc"; . "$HOME/.bash_login"; printf "%s" "$PATH"'], {
    env: { HOME: f.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000,
  })
  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${f.bin}:/usr/bin:/bin`)
  expect(readFileSync(login, 'utf8')).toContain('# preserve chosen login file\n')
})

it.skipIf(process.platform === 'win32')('resumes after profile publication with a pending ownership receipt without duplicating the block', () => {
  const f = fixture()
  let receipt: unknown = null, writes = 0, interrupted = true
  const installation = new ShellPathInstallation({ home: f.home, bin: f.bin, shell: '/bin/zsh',
    read: () => receipt, save: value => {
      if (++writes > 1 && interrupted) throw new Error('storage interrupted')
      receipt = JSON.parse(JSON.stringify(value))
    } })
  expect(installation.configure().ok).toBe(false)
  const before = readFileSync(path.join(f.home, '.zshrc'), 'utf8')
  interrupted = false
  expect(installation.configure().ok).toBe(true)
  expect(readFileSync(path.join(f.home, '.zshrc'), 'utf8')).toBe(before)
  expect(installation.remove().ok).toBe(true)
})
