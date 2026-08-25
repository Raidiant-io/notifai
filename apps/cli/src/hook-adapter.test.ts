import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hookAdapterPath,
  hookAdapterSource,
  inspectHookAdapter,
  installHookAdapter,
  isNpxAdapterTarget,
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
    const inspected = inspectHookAdapter(homeDir).target
    expect(inspected && !isNpxAdapterTarget(inspected) ? inspected.scriptPath : null).toBe(second)
  })

  it('executes a pinned npx spec through npm-cli.js without evaluating it', () => {
    const { root, homeDir } = isolated()
    const npmCli = path.join(root, 'npm-cli.js')
    writeFileSync(
      npmCli,
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n',
    )
    const installed = installHookAdapter(
      {
        kind: 'npx',
        execPath: process.execPath,
        npmCli,
        spec: '@raidiant/notifai@0.5.1',
      },
      homeDir,
    )
    const run = spawnSync(installed.path, ['hook', 'stop', '--owner', 'notifai'], {
      encoding: 'utf8',
    })

    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual([
      'exec',
      '--yes',
      '--package',
      '@raidiant/notifai@0.5.1',
      '--',
      'notifai',
      'hook',
      'stop',
      '--owner',
      'notifai',
    ])
    const inspected = inspectHookAdapter(homeDir)
    expect(inspected.problems).toEqual([])
    expect(inspected.target && isNpxAdapterTarget(inspected.target) ? inspected.target.spec : null).toBe(
      '@raidiant/notifai@0.5.1',
    )
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

  it('keeps working when a node upgrade moved the pinned runtime but left the CLI', () => {
    const { root, homeDir } = isolated()
    const bin = path.join(root, 'fallback-bin')
    mkdirSync(bin, { recursive: true })
    const pathNode = path.join(bin, 'node')
    writeFileSync(pathNode, '#!/bin/sh\nprintf "ran %s" "$1"\n')
    chmodSync(pathNode, 0o700)
    const pinnedNode = path.join(root, 'pinned-node')
    const cli = path.join(root, 'cli.js')
    writeFileSync(pinnedNode, '#!/bin/sh\n')
    chmodSync(pinnedNode, 0o700)
    writeFileSync(cli, '')
    const installed = installHookAdapter({ execPath: pinnedNode, scriptPath: cli }, homeDir)
    // What `brew upgrade node` and `nvm uninstall` both do: the interpreter
    // moves, the installed CLI does not.
    rmSync(pinnedNode)

    const run = spawnSync(installed.path, ['hook', 'stop'], {
      encoding: 'utf8',
      env: { PATH: bin },
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe(`ran ${cli}`)
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

describe('Windows hook adapter', () => {
  it('keeps POSIX adapter source bytes identical to the trusted /bin/sh form', () => {
    const target = {
      execPath: '/usr/local/bin/node',
      scriptPath: '/opt/notifai/dist/main.js',
    }
    expect(hookAdapterSource(target, 'posix')).toBe(`#!/bin/sh
# notifai managed hook adapter
# adapter-version: 2
# target-exec-json: "/usr/local/bin/node"
# target-script-json: "/opt/notifai/dist/main.js"
set -eu

registered_exec='/usr/local/bin/node'
registered_script='/opt/notifai/dist/main.js'

if [ -x "$registered_exec" ] && [ -f "$registered_script" ]; then
  exec "$registered_exec" "$registered_script" "$@"
fi

if [ -f "$registered_script" ] && command -v node >/dev/null 2>&1; then
  exec node "$registered_script" "$@"
fi

printf '%s
' 'Notifai hook adapter target is stale; run notifai hooks install.' >&2
exit 127
`)
  })

  it('generates a JavaScript adapter instead of a shebang script', () => {
    const { root, homeDir } = isolated()
    const script = path.join(root, 'target.js')
    writeFileSync(script, '')
    const installed = installHookAdapter(
      { execPath: process.execPath, scriptPath: script },
      homeDir,
      'win32',
    )
    const source = readFileSync(installed.path, 'utf8')

    expect(source.startsWith('// notifai managed hook adapter\n')).toBe(true)
    expect(source).not.toContain('#!/bin/sh')
    expect(source).toContain('require("node:child_process")')
    expect(source).toContain(JSON.stringify(process.execPath))
    expect(source).toContain(JSON.stringify(script))
  })

  it('forwards argv through Node without depending on a shebang or executable bit', () => {
    const { root, homeDir } = isolated()
    const script = path.join(root, 'target script.js')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    const runtime = path.join(root, 'node-runtime')
    writeFileSync(runtime, 'dummy-node')
    chmodSync(runtime, 0o644)

    const installed = installHookAdapter(
      { execPath: process.execPath, scriptPath: script },
      homeDir,
      'win32',
    )
    const run = spawnSync(process.execPath, [installed.path, 'hook', 'stop', '--owner', 'notifai'], {
      encoding: 'utf8',
    })

    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual(['hook', 'stop', '--owner', 'notifai'])
    expect(() =>
      installHookAdapter({ execPath: runtime, scriptPath: script }, homeDir, 'win32'),
    ).not.toThrow()
  })

  it('does not treat 0666 as a protection or health failure', () => {
    const { root, homeDir } = isolated()
    const script = path.join(root, 'target.js')
    writeFileSync(script, '')
    const installed = installHookAdapter(
      { execPath: process.execPath, scriptPath: script },
      homeDir,
      'win32',
    )
    chmodSync(installed.path, 0o666)

    expect(inspectHookAdapter(homeDir, 'win32').problems).toEqual([])
    expect(
      installHookAdapter({ execPath: process.execPath, scriptPath: script }, homeDir, 'win32'),
    ).toEqual({ path: installed.path, changed: false })
  })

  it('fails closed when the registered Windows target vanishes', () => {
    const { root, homeDir } = isolated()
    const oldNode = path.join(root, 'old-node')
    const oldCli = path.join(root, 'old-cli.js')
    writeFileSync(oldNode, '#!/bin/sh\n')
    writeFileSync(oldCli, '')
    const installed = installHookAdapter(
      { execPath: oldNode, scriptPath: oldCli },
      homeDir,
      'win32',
    )
    rmSync(oldNode)
    rmSync(oldCli)

    const inspected = inspectHookAdapter(homeDir, 'win32')
    expect(inspected.problems).toEqual([
      `registered runtime ${oldNode} is missing`,
      `registered CLI ${oldCli} is missing`,
    ])
    const run = spawnSync(process.execPath, [installed.path, 'hook', 'stop'], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(127)
    expect(run.stdout).toBe('')
    expect(run.stderr).toMatch(/target is stale/)
  })

  it('retargets the CLI without changing the adapter pathname', () => {
    const { root, homeDir } = isolated()
    const first = path.join(root, 'first.js')
    const second = path.join(root, 'second.js')
    writeFileSync(first, '')
    writeFileSync(second, '')
    const firstInstall = installHookAdapter(
      { execPath: process.execPath, scriptPath: first },
      homeDir,
      'win32',
    )
    const secondInstall = installHookAdapter(
      { execPath: process.execPath, scriptPath: second },
      homeDir,
      'win32',
    )
    const inspected = inspectHookAdapter(homeDir, 'win32').target

    expect(secondInstall.path).toBe(firstInstall.path)
    expect(inspected && !isNpxAdapterTarget(inspected) ? inspected.scriptPath : null).toBe(second)
  })
})
