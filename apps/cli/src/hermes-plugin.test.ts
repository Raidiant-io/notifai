import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { hermesPluginDir, hermesPluginSource, installHermesPlugin, preflightHermesPlugin, refreshHermesPlugin, uninstallHermesPlugin } from './hermes-plugin.js'
import type { IntegrationPublication } from './native-installation.js'

const roots: string[] = []
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })))

it.skipIf(process.platform === 'win32')('uses one scoped host operation for setup, enable and removal, retaining interrupted source', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-host-contract-')); roots.push(root)
  const bin = path.join(root, 'bin'); mkdirSync(bin)
  // This host fixture tests the CLI boundary, not Hermes activation semantics.
  const host = path.join(bin, 'hermes')
  writeFileSync(host, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), url = require('node:url');
const args = process.argv.slice(2), target = path.join(process.env.HERMES_HOME, 'plugins', 'notifai');
if (args[0] === '--version') console.log('Hermes Agent v0.21.5');
else if (args[1] === 'list') { if (fs.existsSync(target)) console.log('enabled local 1.0.0 notifai'); }
else if (args[1] === 'install') {
  if (process.env.NOTIFAI_TEST_HOST_FAIL) process.exit(1);
  if (args.includes('--force')) process.exit(2);
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['__init__.py', 'plugin.yaml']) fs.copyFileSync(path.join(url.fileURLToPath(args[2]), name), path.join(target, name));
} else if (args[1] === 'remove') fs.rmSync(target, { recursive: true, force: true });
`, { mode: 0o700 })
  const env = { HOME: root, HERMES_HOME: path.join(root, 'hermes'), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }
  const operations: string[] = [], sources: string[] = []
  const publish: IntegrationPublication = action => action()
  publish.host = (input, action) => {
    operations.push(input.operation)
    if (input.source) sources.push(input.source)
    return action()
  }
  const installed = installHermesPlugin('/stable/adapter', env, undefined, publish)
  expect(operations).toEqual(['install'])
  expect(existsSync(sources[0]!)).toBe(false)
  const manifest = readFileSync(path.join(installed, 'plugin.yaml'), 'utf8')
  installHermesPlugin('/new/adapter', env, undefined, publish)
  expect(operations).toEqual(['install', 'enable'])
  expect(readFileSync(path.join(installed, 'plugin.yaml'), 'utf8')).toBe(manifest)
  expect(uninstallHermesPlugin(env, publish)).toBe(true)
  expect(operations).toEqual(['install', 'enable', 'remove'])
  expect(() => installHermesPlugin('/stable/adapter', { ...env, NOTIFAI_TEST_HOST_FAIL: '1' }, undefined, publish)).toThrow(/Hermes/)
  const retained = sources.at(-1)!; roots.push(retained)
  expect(existsSync(path.join(retained, '__init__.py'))).toBe(true)
})

it('refreshes an owned Hermes module without invoking the host or changing its enablement', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-refresh-')); roots.push(root)
  const env = { HOME: root, HERMES_HOME: path.join(root, 'hermes'), PATH: '' }, dir = hermesPluginDir(env)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '__init__.py'), hermesPluginSource('/old/adapter'))
  writeFileSync(path.join(dir, 'plugin.yaml'), 'name: notifai\n')
  const settings = path.join(env.HERMES_HOME, 'config.yaml'), contents = 'plugins:\n  notifai:\n    enabled: false\n'
  writeFileSync(settings, contents)
  expect(refreshHermesPlugin('/new/adapter', env)).toBe(dir)
  expect(readFileSync(path.join(dir, '__init__.py'), 'utf8')).toBe(hermesPluginSource('/new/adapter', undefined, path.join(dir, '__init__.py')))
  expect(readFileSync(settings, 'utf8')).toBe(contents)
  expect(readFileSync(path.join(dir, 'plugin.yaml'), 'utf8')).toBe('name: notifai\n')
})

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
