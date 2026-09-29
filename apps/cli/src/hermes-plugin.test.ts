import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { hermesPluginDir, hermesPluginSource, installHermesPlugin, preflightHermesPlugin, uninstallHermesPlugin } from './hermes-plugin.js'

const roots: string[] = []
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })))

it('leaves a foreign Hermes plugin with the same name untouched', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-foreign-'))
  roots.push(root)
  const env = { HOME: root, HERMES_HOME: path.join(root, 'hermes') }
  const dir = hermesPluginDir(env)
  mkdirSync(dir, { recursive: true })
  const source = '# foreign plugin\n'
  writeFileSync(path.join(dir, '__init__.py'), source)
  writeFileSync(path.join(dir, 'plugin.yaml'), 'name: notifai\n')

  expect(() => installHermesPlugin('/unused/adapter', env)).toThrow(/foreign/)
  expect(() => uninstallHermesPlugin(env)).toThrow(/foreign/)
  expect(readFileSync(path.join(dir, '__init__.py'), 'utf8')).toBe(source)
})

it.skipIf(process.platform === 'win32')('refuses a discovered foreign entry point before installing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-entrypoint-'))
  roots.push(root)
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  const hermes = path.join(bin, 'hermes')
  writeFileSync(hermes, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Hermes Agent v0.21.5"; else echo "not enabled  entrypoint 1.0.0    notifai"; fi\n')
  chmodSync(hermes, 0o755)
  const env = { HOME: root, HERMES_HOME: path.join(root, 'hermes'), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }

  expect(() => preflightHermesPlugin(env)).toThrow(/foreign plugin/)
  expect(() => installHermesPlugin('/unused/adapter', env)).toThrow(/foreign plugin/)
})

it.skipIf(process.platform === 'win32')('checks the claim deadline at the Hermes injection point', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-expired-write-'))
  roots.push(root)
  const plugin = path.join(root, 'plugin.py')
  const child = path.join(root, 'child.py')
  writeFileSync(plugin, hermesPluginSource('/unused/adapter'))
  writeFileSync(child, `import json, sys, time\nfor line in sys.stdin:\n    frame = json.loads(line)\n    if frame.get('type') == 'state':\n        deadline = 0 if sys.argv[2] == 'expired' else time.time_ns() // 1_000_000 + 3000\n        print(json.dumps({'type': 'write', 'id': 1, 'session_id': 'same', 'text': 'note', 'deadline_ms': deadline}), flush=True)\n    elif frame.get('type') == 'result':\n        with open(sys.argv[1], 'w') as out:\n            json.dump(frame, out)\n        break\n`)
  const harness = `import importlib.util, json, sys, threading\nspec = importlib.util.spec_from_file_location('plugin', sys.argv[1])\nmodule = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nmodule.COMMAND = [sys.executable, sys.argv[2], sys.argv[3], sys.argv[5]]\ncalls = []\nclass Cli:\n    session_id = 'same'\n    _agent_running = False\nclass Manager:\n    _cli_ref = Cli()\nclass Ctx:\n    _manager = Manager()\n    def inject_message(self, text):\n        calls.append(text)\n        return True\nmodule._run_attendant(Ctx(), 'same', sys.argv[4], threading.Event())\nprint(json.dumps(calls))\n`
  for (const mode of ['expired', 'fresh']) {
    const resultFile = path.join(root, `${mode}.json`)
    const run = spawnSync('python3', ['-c', harness, plugin, child, resultFile, root, mode], {
      encoding: 'utf8', timeout: 10_000,
    })
    expect(run.error).toBeUndefined()
    expect(run.status).toBe(0)
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toMatchObject({
      type: 'result', id: 1, accepted: mode === 'fresh',
    })
    expect(JSON.parse(run.stdout)).toEqual(mode === 'fresh' ? ['note'] : [])
  }
})
