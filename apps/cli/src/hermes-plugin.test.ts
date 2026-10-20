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

const PLUGIN_HARNESS = String.raw`import importlib.util, json, sys, threading, time
spec = importlib.util.spec_from_file_location('plugin', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.COMMAND = [sys.executable, sys.argv[2], sys.argv[3], sys.argv[4]]
calls = []
hooks = {}
class Ctx:
    # Only the public PluginContext surface: no manager or attached CLI.
    def register_system_prompt_section(self, *args, **kwargs):
        pass
    def register_hook(self, name, callback):
        hooks[name] = callback
    def inject_message(self, text, role="user", **kwargs):
        calls.append({"text": text, "role": role, **kwargs})
        return True
ctx = Ctx()
module.register(ctx)
scenario = sys.argv[4]
module._observe_session("same")
if scenario == "approval":
    hooks["pre_approval_request"](command="rm -rf build", surface="cli")
if scenario == "smart":
    hooks["pre_approval_request"](command="rm -rf build", surface="smart")
if scenario == "working":
    hooks["pre_llm_call"](session_id="same", platform="cli", parent_session_id="")
if scenario == "child":
    hooks["pre_llm_call"](session_id="child", platform="cli", parent_session_id="same")
if scenario == "resume":
    hooks["pre_command"](surface="cli", command="resume", session_key="same")
    threading.Timer(0.5, lambda: hooks["pre_llm_call"](session_id="other", platform="cli", parent_session_id="")).start()
module._run_attendant(ctx, "same", sys.argv[5], threading.Event())
print(json.dumps(calls))
`

const PLUGIN_CHILD = String.raw`import json, sys, time
states = []
for line in sys.stdin:
    frame = json.loads(line)
    if frame.get('type') == 'state':
        states.append(frame['activity'])
        if len(states) == 1:
            deadline = 0 if sys.argv[2] == 'expired' else time.time_ns() // 1_000_000 + 3000
            print(json.dumps({'type': 'write', 'id': 1, 'session_id': 'same', 'text': 'note', 'deadline_ms': deadline}), flush=True)
    elif frame.get('type') == 'result':
        with open(sys.argv[1], 'w') as out:
            json.dump({**frame, 'states': states}, out)
        if sys.argv[2] != 'resume':
            break
    elif frame.get('type') == 'end':
        with open(sys.argv[1] + '.end', 'w') as out:
            json.dump(frame, out)
        break
`

function runPluginScenario(root: string, scenario: string): { result: Record<string, unknown>; calls: unknown[]; ended: boolean } {
  const plugin = path.join(root, 'plugin.py'), child = path.join(root, 'child.py')
  writeFileSync(plugin, hermesPluginSource('/unused/adapter'))
  writeFileSync(child, PLUGIN_CHILD)
  const resultFile = path.join(root, `${scenario}.json`)
  const run = spawnSync('python3', ['-c', PLUGIN_HARNESS, plugin, child, resultFile, scenario, root], {
    encoding: 'utf8', timeout: 15_000,
  })
  expect(run.error).toBeUndefined()
  expect(run.status).toBe(0)
  return {
    result: JSON.parse(readFileSync(resultFile, 'utf8')) as Record<string, unknown>,
    calls: JSON.parse(run.stdout) as unknown[],
    ended: existsSync(`${resultFile}.end`),
  }
}

it.skipIf(process.platform === 'win32')('writes through inject_message aimed at the exact session, inside the claim deadline', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-write-')); roots.push(root)
  const fresh = runPluginScenario(root, 'fresh')
  expect(fresh.result).toMatchObject({ type: 'result', id: 1, accepted: true, states: ['idle'] })
  // An explicit target and never an origin, which could start a session.
  expect(fresh.calls).toEqual([{ text: 'note', role: 'user', session_key: 'same' }])
  const expired = runPluginScenario(root, 'expired')
  expect(expired.result).toMatchObject({ accepted: false })
  expect(expired.calls).toEqual([])
})

it.skipIf(process.platform === 'win32')('holds a write while Hermes waits on an approval, so it cannot answer the prompt', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-approval-')); roots.push(root)
  const held = runPluginScenario(root, 'approval')
  expect(held.result).toMatchObject({ accepted: false, reason: 'approval-pending' })
  expect(held.calls).toEqual([])
  // The guardian model's assessment is not a User prompt and may never report an outcome.
  expect(runPluginScenario(root, 'smart').result).toMatchObject({ accepted: true })
})

it.skipIf(process.platform === 'win32')('reports the turn from public hooks and ignores delegated child turns', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-activity-')); roots.push(root)
  expect(runPluginScenario(root, 'working').result).toMatchObject({ states: ['working'] })
  expect(runPluginScenario(root, 'child').result).toMatchObject({ states: ['idle'] })
})

it.skipIf(process.platform === 'win32')('holds writes from a session-switching command and retires once another session is current', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-resume-')); roots.push(root)
  const resumed = runPluginScenario(root, 'resume')
  expect(resumed.result).toMatchObject({ accepted: false, reason: 'session-switching' })
  expect(resumed.calls).toEqual([])
  expect(resumed.ended).toBe(true)
})
