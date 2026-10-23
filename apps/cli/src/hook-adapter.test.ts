import { execFileSync,spawnSync } from 'node:child_process'
import {
chmodSync,
existsSync,
mkdirSync,
mkdtempSync,
readFileSync,
symlinkSync,
writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { describe,expect,it,vi } from 'vitest'
import {
hookAdapterPath,
hookAdapterSource,
inspectHookAdapter,
installHookAdapter,
resolveHookAdapterHome
} from './hook-adapter.js'
import { enableProject,projectBinding } from './project-enablement.js'

function isolated(): { root: string; homeDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hook-adapter-'))
  return { root, homeDir: path.join(root, 'home') }
}

describe('stable hook adapter', () => {
  it('keeps the installed adapter silent until the Project is enabled', () => {
    const { root, homeDir } = isolated()
    execFileSync('git', ['init', '-q', root])
    const env = {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    }
    const scriptPath = fileURLToPath(new URL('../dist/main.js', import.meta.url))
    const installed = installHookAdapter({ execPath: process.execPath, scriptPath }, homeDir)
    const disabled = spawnSync(
      installed.path,
      ['hook', 'session-start', '--owner', 'notifai', '--harness', 'codex'],
      {
        encoding: 'utf8',
        input: JSON.stringify({ session_id: 'adapter-session', cwd: root, source: 'startup' }),
        env,
      },
    )

    expect(disabled.status).toBe(0)
    expect(disabled.stderr).toBe('')
    expect(disabled.stdout).toBe('')

    const binding = projectBinding(root, env)
    if (binding === null) throw new Error('test Project binding unavailable')
    enableProject(binding)
    const run = spawnSync(
      installed.path,
      ['hook', 'session-start', '--owner', 'notifai', '--harness', 'codex'],
      {
        encoding: 'utf8',
        input: JSON.stringify({ session_id: 'adapter-session', cwd: root, source: 'startup' }),
        env,
      },
    )

    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')
    expect(JSON.parse(run.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: expect.stringMatching(/Notifai.*enabled.*Project/i),
      },
    })
  })

  it('refuses an ambiguous install so a scratch HOME cannot retarget the real adapter', () => {
    const { root, homeDir } = isolated()
    const script = path.join(root, 'target.js')
    writeFileSync(script, '')
    const osAdapter = hookAdapterPath()
    const existed = existsSync(osAdapter)
    const before = existed ? readFileSync(osAdapter, 'utf8') : null
    const original = process.env['HOME']
    process.env['HOME'] = path.join(root, 'attacker-home')
    try {
      expect(() =>
        installHookAdapter({ execPath: process.execPath, scriptPath: script }),
      ).toThrow(/explicit adapter home/i)
      expect(existsSync(osAdapter)).toBe(existed)
      if (existed) expect(readFileSync(osAdapter, 'utf8')).toBe(before)
      expect(existsSync(hookAdapterPath(process.env['HOME']))).toBe(false)

      const isolatedInstall = installHookAdapter(
        { execPath: process.execPath, scriptPath: script },
        homeDir,
      )
      expect(isolatedInstall.path).toBe(hookAdapterPath(homeDir))
      expect(existsSync(isolatedInstall.path)).toBe(true)
      expect(existsSync(osAdapter)).toBe(existed)
      if (existed) expect(readFileSync(osAdapter, 'utf8')).toBe(before)
    } finally {
      if (original === undefined) delete process.env['HOME']
      else process.env['HOME'] = original
    }
  })
})

const nativeWindowsIt = process.platform === 'win32' ? it : it.skip

describe('Windows hook adapter', () => {
  nativeWindowsIt(
    'allows concurrent Windows installers to create one managed adapter directory',
    async () => {
    const { root, homeDir } = isolated()
    const scriptPath = path.join(root, 'target.js')
    writeFileSync(scriptPath, '')
    const moduleUrl = new URL('../dist/hook-adapter.js', import.meta.url).href
    const start = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const workers = Array.from(
      { length: 16 },
      () =>
        new Worker(
          `
            const { parentPort, workerData } = require('node:worker_threads')
            ;(async () => {
              const { installHookAdapter } = await import(workerData.moduleUrl)
              parentPort.postMessage('ready')
              Atomics.wait(new Int32Array(workerData.start), 0, 0)
              installHookAdapter(
                { execPath: workerData.execPath, scriptPath: workerData.scriptPath },
                workerData.homeDir,
                'win32',
              )
              parentPort.postMessage('done')
            })().catch((error) => {
              throw error
            })
          `,
          {
            eval: true,
            workerData: { moduleUrl, start, execPath: process.execPath, scriptPath, homeDir },
          },
        ),
    )

    const completed = workers.map(
      (worker) =>
        new Promise<void>((resolve, reject) => {
          worker.on('message', (message) => {
            if (message === 'done') resolve()
          })
          worker.on('error', reject)
          worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`adapter installer worker exited ${code}`))
          })
        }),
    )
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve) => {
            worker.once('message', () => resolve())
          }),
      ),
    )
    Atomics.store(new Int32Array(start), 0, 1)
    Atomics.notify(new Int32Array(start), 0)

    await Promise.all(completed)
    expect(inspectHookAdapter(homeDir, 'win32').problems).toEqual([])
  })

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

NOTIFAI_HOOK_SOURCE_PID=$PPID
export NOTIFAI_HOOK_SOURCE_PID

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
})


describe('OS-account adapter admission', () => {
  it.each([
    ['C:/scratch', 'C:/Users/account'],
    ['C:/Users/account', 'C:/scratch'],
    ['C:/scratch', 'C:/scratch'],
  ])('refuses conflicting Windows HOME=%s and USERPROFILE=%s', (home, profile) => {
    const spy = vi.spyOn(os, 'userInfo').mockReturnValue({ ...os.userInfo(), homedir: 'C:/Users/account' })
    try {
      expect(() => resolveHookAdapterHome(undefined, { HOME: home, USERPROFILE: profile }, 'win32'))
        .toThrow(/explicit adapter home/i)
    } finally { spy.mockRestore() }
  })

  it('preserves immutable identity for a POSIX home alias', () => {
    const { root, homeDir } = isolated()
    mkdirSync(homeDir)
    const alias = path.join(root, 'alias')
    symlinkSync(homeDir, alias, 'dir')
    const spy = vi.spyOn(os, 'userInfo').mockReturnValue({ ...os.userInfo(), homedir: homeDir })
    try {
      expect(resolveHookAdapterHome(undefined, { HOME: alias }, 'posix')).toBe(homeDir)
    } finally { spy.mockRestore() }
  })
})
