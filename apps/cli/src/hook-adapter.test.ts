import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withFileLockSync } from './atomic-file.js'
import {
  hookAdapterPath,
  inspectHookAdapter,
  installHookAdapter,
} from './hook-adapter.js'
import { buildHookConfig, codexHookIdentityHash, type InstalledHandler } from './install-hooks.js'

function isolated(): { root: string; homeDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hook-adapter-'))
  return { root, homeDir: path.join(root, 'home') }
}

describe('stable hook adapter', () => {
  it('executes paths with spaces, quotes, and shell syntax without evaluating them', () => {
    const { root, homeDir } = isolated()
    const odd = path.join(root, "odd ' $(touch should-not-run)")
    mkdirSync(odd, { recursive: true })
    const script = path.join(odd, 'target script.js')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')

    const installed = installHookAdapter({ execPath: process.execPath, scriptPath: script }, homeDir)
    const run = spawnSync(installed.path, ['hook', 'stop', '--owner', 'notifai'], {
      encoding: 'utf8',
    })

    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual(['hook', 'stop', '--owner', 'notifai'])
    expect(statSync(installed.path).mode & 0o777).toBe(0o700)
    expect(inspectHookAdapter(homeDir).problems).toEqual([])
  })

  it('retargets Node and CLI paths without changing any harness definition or Codex hash', () => {
    const { root, homeDir } = isolated()
    const first = path.join(root, 'first.js')
    const second = path.join(root, 'second.js')
    writeFileSync(first, '')
    writeFileSync(second, '')
    const adapter = installHookAdapter({ execPath: process.execPath, scriptPath: first }, homeDir)
    const before = buildHookConfig({
      adapterPath: adapter.path,
      harness: 'codex',
    })
    const beforeSource = readFileSync(adapter.path, 'utf8')

    installHookAdapter({ execPath: process.execPath, scriptPath: second }, homeDir)
    const after = buildHookConfig({
      adapterPath: hookAdapterPath(homeDir),
      harness: 'codex',
    })
    const afterSource = readFileSync(adapter.path, 'utf8')
    const stop = (config: typeof before): InstalledHandler => {
      const handler = config['Stop']![0]!.hooks[0]!
      return {
        event: 'Stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: handler.command,
        timeout: handler.timeout,
      }
    }

    expect(after).toEqual(before)
    expect(afterSource).not.toBe(beforeSource)
    expect(codexHookIdentityHash(stop(after))).toBe(codexHookIdentityHash(stop(before)))
    expect(inspectHookAdapter(homeDir).target?.scriptPath).toBe(second)
  })

  it('uses a fixed home-relative pathname with no XDG input surface', () => {
    const { homeDir } = isolated()
    expect(hookAdapterPath(homeDir)).toBe(
      path.join(homeDir, '.notifai', 'bin', 'hook-adapter'),
    )
  })

  it('uses the OS account home even when HOME is overridden', () => {
    const original = process.env['HOME']
    process.env['HOME'] = '/tmp/attacker-selected-home'
    try {
      expect(hookAdapterPath()).toBe(
        path.join(os.userInfo().homedir, '.notifai', 'bin', 'hook-adapter'),
      )
      expect(hookAdapterPath()).not.toContain('attacker-selected-home')
    } finally {
      if (original === undefined) delete process.env['HOME']
      else process.env['HOME'] = original
    }
  })

  it('repairs permissive adapter permissions without changing its path', () => {
    const { root, homeDir } = isolated()
    const script = path.join(root, 'target.js')
    writeFileSync(script, '')
    const first = installHookAdapter({ execPath: process.execPath, scriptPath: script }, homeDir)
    chmodSync(first.path, 0o755)

    const repaired = installHookAdapter({ execPath: process.execPath, scriptPath: script }, homeDir)

    expect(repaired).toEqual({ path: first.path, changed: true })
    expect(statSync(first.path).mode & 0o777).toBe(0o700)
  })

  it('refuses a symlinked adapter instead of reading or replacing its target', () => {
    const { root, homeDir } = isolated()
    const target = path.join(root, 'foreign')
    const adapter = hookAdapterPath(homeDir)
    mkdirSync(path.dirname(adapter), { recursive: true })
    writeFileSync(target, 'leave me')
    symlinkSync(target, adapter)

    expect(() =>
      installHookAdapter({ execPath: process.execPath, scriptPath: target }, homeDir),
    ).toThrow(/not a regular file/)
    expect(readFileSync(target, 'utf8')).toBe('leave me')
  })

  it('refuses a symlinked Notifai-owned parent directory', () => {
    const { root, homeDir } = isolated()
    const foreign = path.join(root, 'foreign-dir')
    const script = path.join(root, 'target.js')
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(foreign)
    writeFileSync(script, '')
    symlinkSync(foreign, path.join(homeDir, '.notifai'))

    expect(() =>
      installHookAdapter({ execPath: process.execPath, scriptPath: script }, homeDir),
    ).toThrow(/not a regular directory/)
    expect(readFileSync(script, 'utf8')).toBe('')
  })

  it('diagnoses a stale registered runtime and CLI without executing either', () => {
    const { root, homeDir } = isolated()
    const missingRuntime = path.join(root, 'removed-node')
    const missingCli = path.join(root, 'removed-cli.js')
    writeFileSync(missingRuntime, '#!/bin/sh\n')
    chmodSync(missingRuntime, 0o700)
    writeFileSync(missingCli, '')
    installHookAdapter({ execPath: missingRuntime, scriptPath: missingCli }, homeDir)
    rmSync(missingRuntime)
    rmSync(missingCli)

    expect(inspectHookAdapter(homeDir).problems).toEqual([
      `registered runtime ${missingRuntime} is missing`,
      `registered CLI ${missingCli} is missing`,
    ])
  })

  it('fails closed instead of executing an unregistered PATH target after the registered target vanished', () => {
    const { root, homeDir } = isolated()
    const bin = path.join(root, 'new-bin')
    const replacement = path.join(bin, 'notifai')
    mkdirSync(bin, { recursive: true })
    writeFileSync(replacement, '#!/bin/sh\nprintf "%s" "$*"\n')
    chmodSync(replacement, 0o700)
    const oldNode = path.join(root, 'old-node')
    const oldCli = path.join(root, 'old-cli.js')
    writeFileSync(oldNode, '#!/bin/sh\n')
    chmodSync(oldNode, 0o700)
    writeFileSync(oldCli, '')
    const installed = installHookAdapter({ execPath: oldNode, scriptPath: oldCli }, homeDir)
    rmSync(oldNode)
    rmSync(oldCli)

    const run = spawnSync(installed.path, ['hook', 'stop'], {
      encoding: 'utf8',
      env: { PATH: bin },
    })

    expect(run.status).toBe(127)
    expect(run.stdout).toBe('')
    expect(run.stderr).toMatch(/target is stale/)
  })
})

describe('installer transaction lock', () => {
  it('does not barge past a live concurrent operation', () => {
    const { root } = isolated()
    const file = path.join(root, 'settings.json')
    const lock = path.join(root, '.settings.json.notifai.lock')
    writeFileSync(lock, 'live')

    expect(() => withFileLockSync(file, () => {}, { timeoutMs: 20, staleMs: 10_000 })).toThrow(
      /Timed out waiting/,
    )
    expect(readFileSync(lock, 'utf8')).toBe('live')
  })

  it('reclaims only an old regular lock owned by this user', () => {
    const { root } = isolated()
    const file = path.join(root, 'settings.json')
    const lock = path.join(root, '.settings.json.notifai.lock')
    writeFileSync(lock, 'abandoned')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)

    const result = withFileLockSync(file, () => 'acquired', { staleMs: 1_000 })

    expect(result).toBe('acquired')
  })

  it('refuses a symlink posing as a lock', () => {
    const { root } = isolated()
    const file = path.join(root, 'settings.json')
    const lock = path.join(root, '.settings.json.notifai.lock')
    const target = path.join(root, 'foreign')
    writeFileSync(target, 'leave me')
    symlinkSync(target, lock)

    expect(() => withFileLockSync(file, () => {})).toThrow(/not a regular lock file/)
    expect(readFileSync(target, 'utf8')).toBe('leave me')
  })

  it('refuses a symlinked settings directory before creating a lock', () => {
    const { root } = isolated()
    const foreign = path.join(root, 'foreign-dir')
    const linked = path.join(root, 'linked-dir')
    mkdirSync(foreign)
    symlinkSync(foreign, linked)

    expect(() => withFileLockSync(path.join(linked, 'settings.json'), () => {})).toThrow(
      /not a regular directory/,
    )
    expect(existsSync(path.join(foreign, '.settings.json.notifai.lock'))).toBe(false)
  })

  it('does not remove a replacement that appears at the lock path while held', () => {
    const { root } = isolated()
    const file = path.join(root, 'settings.json')
    const lock = path.join(root, '.settings.json.notifai.lock')

    expect(() =>
      withFileLockSync(file, () => {
        rmSync(lock)
        writeFileSync(lock, 'replacement')
      }),
    ).toThrow(/changed while held/)
    expect(readFileSync(lock, 'utf8')).toBe('replacement')
  })

  it('preserves the action error when cleanup also finds a replacement', () => {
    const { root } = isolated()
    const file = path.join(root, 'settings.json')
    const lock = path.join(root, '.settings.json.notifai.lock')
    const actionError = new Error('merge failed')

    expect(() =>
      withFileLockSync(file, () => {
        rmSync(lock)
        writeFileSync(lock, 'replacement')
        throw actionError
      }),
    ).toThrow(actionError)
    expect(readFileSync(lock, 'utf8')).toBe('replacement')
  })
})
