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

// A copy of Hermes's render loop (hermes_cli/plugins.py,
// PluginManager.render_system_prompt_sections, unchanged in what it decides
// from v0.20.6 through v0.22.4): sections in id order, the section count
// checked before a section is rendered, then each at most its max_chars and
// all within one shared 8,000-character budget. It is a copy, so it proves
// the plugin's side only. Prompt freezing and history are not modelled,
// because the plugin depends on neither.
const SECTIONS_HARNESS = String.raw`import importlib.util, json, sys, types
hermes = json.loads(sys.argv[6])
if hermes.get("version") is None:
    sys.modules["hermes_cli"] = None
else:
    package = types.ModuleType("hermes_cli")
    package.__path__ = []
    package.__version__ = hermes["version"]
    sys.modules["hermes_cli"] = package
    if hermes.get("base_version"):
        info = types.ModuleType("hermes_cli.version_info")
        info.get_version_info = lambda: types.SimpleNamespace(base_version=hermes["base_version"])
        sys.modules["hermes_cli.version_info"] = info
spec = importlib.util.spec_from_file_location('plugin', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.COMMAND = [sys.executable, sys.argv[2], sys.argv[3]]
case, cwd = sys.argv[4], sys.argv[5]
sections, hooks = {}, {}
class Ctx:
    def register_system_prompt_section(self, id, content, position="after_memory", max_chars=4000):
        sections[id] = (content, max_chars)
    def register_hook(self, name, callback):
        hooks[name] = callback
    def inject_message(self, *args, **kwargs):
        return True
module.register(Ctx())
START, END = "<!-- hermes-plugin-sections:start -->", "<!-- hermes-plugin-sections:end -->"
def frame(section_id, text):
    return "## Plugin Context: %s\n<!-- hermes-plugin-section-chars:%d -->\n\n%s" % (section_id, len(text), text)
def render(info, used=0, earlier=0):
    rendered, total = [], len(START) + len(END) + 2 + used
    for section_id in sorted(sections):
        content, max_chars = sections[section_id]
        if earlier + len(rendered) >= 32:
            continue
        text = content(info).strip()
        if not text or len(text) > max_chars:
            continue
        cost = len(frame(section_id, text)) + (2 if rendered else 0)
        if total + cost > 8000:
            continue
        rendered.append([section_id, text[:1]])
        total += cost
    return rendered
main = {"session_id": "main", "platform": "cli", "cwd": cwd}
child = {"session_id": "child", "platform": "subagent", "cwd": cwd}
room = 8000 - len(START) - len(END) - 2
if case == "activation-left-out":
    rendered = render(main, used=room - len(frame("notifai.2-guidance", "G" * 1000)) - 10)
elif case == "guidance-left-out":
    rendered = render(main, used=room - len(frame("notifai.1-activation", "A" * 1500)) - 10)
elif case == "count":
    rendered = render(main, earlier=32)
elif case == "worker":
    rendered = render(main) + render(child)
else:
    rendered = render(main)
if case in ("compacted", "child-compacted"):
    # Hermes keeps the system prompt through compression; the history shrinks.
    turns = [hooks["pre_llm_call"](session_id="child" if case == "child-compacted" else "main",
                                    platform="subagent" if case == "child-compacted" else "cli",
                                    parent_session_id="main" if case == "child-compacted" else "", conversation_history=history)
             for history in ([1, 2, 3], [1])]
else:
    turns = [hooks["pre_llm_call"](session_id="main", platform="cli", parent_session_id="") for _ in range(2)]
print(json.dumps({"rendered": rendered, "turns": turns}))
`

// Stands in for the Notifai CLI: two sections when the plugin asks for them,
// or one context as an earlier CLI prints whatever the plugin asks.
const SECTIONS_CLI = String.raw`import json, os, sys
envelope = json.loads(sys.stdin.read())
with open(sys.argv[1], "a") as calls:
    calls.write(json.dumps({"event": sys.argv[3], "sections": envelope.get("hermes_prompt_sections"),
                            **({"compacted": True} if envelope.get("compacted") else {}),
                            **({"worker": True} if envelope.get("hermes_worker") else {})}) + "\n")
event = sys.argv[3]
if event == "guidance-check":
    # Silent unless the session's guidance changed or it was compacted.
    print("C" if envelope.get("compacted") else "N" if os.environ.get("GUIDANCE_CHANGED") else "")
elif envelope.get("hermes_prompt_sections") == 2 and not os.environ.get("EARLIER_CLI"):
    print(json.dumps({"activation": "A" * 1500, "guidance": "G" * 1000} if event == "session-start"
                     else {"activation": "W" * 1000, "guidance": ""}))
else:
    print(("O" if event == "session-start" else "W") * 2000)
`

interface SectionsRun { rendered: [string, string][]; turns: unknown[]; calls: { event: string; sections: number | null; compacted?: boolean; worker?: boolean }[] }

const TURN_CHECKS = [{ event: 'guidance-check', sections: null }, { event: 'guidance-check', sections: null }]

function runSectionsCase(root: string, scenario: string, hermes: { version: string | null; base_version?: string } = { version: '0.21.5' },
  earlierCli = false, changed = false): SectionsRun {
  const plugin = path.join(root, 'plugin.py'), cli = path.join(root, 'cli.py'), calls = path.join(root, `${scenario}.calls`)
  rmSync(calls, { force: true })
  writeFileSync(plugin, hermesPluginSource('/unused/adapter'))
  writeFileSync(cli, SECTIONS_CLI)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('HERMES_') && key !== 'TERMINAL_ENV' && key !== 'TERMINAL_CWD' && key !== 'EARLIER_CLI' && key !== 'GUIDANCE_CHANGED'))
  const run = spawnSync('python3', ['-c', SECTIONS_HARNESS, plugin, cli, calls, scenario, root, JSON.stringify(hermes)], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...env, ...(earlierCli ? { EARLIER_CLI: '1' } : {}), ...(changed ? { GUIDANCE_CHANGED: '1' } : {}) },
  })
  expect(run.error).toBeUndefined()
  expect(run.stderr).not.toMatch(/Traceback/)
  expect(run.status).toBe(0)
  return {
    ...(JSON.parse(run.stdout) as Omit<SectionsRun, 'calls'>),
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as SectionsRun['calls'][number]) : [],
  }
}

it.skipIf(process.platform === 'win32')('renders activation and guidance as two Hermes sections from one CLI call', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-sections-')); roots.push(root)
  const fits = runSectionsCase(root, 'fits')
  expect(fits.rendered).toEqual([['notifai.1-activation', 'A'], ['notifai.2-guidance', 'G']])
  expect(fits.calls).toEqual([{ event: 'session-start', sections: 2 }, ...TURN_CHECKS])
  // A worker renders its own context, never the main session's.
  expect(runSectionsCase(root, 'worker').rendered).toEqual([['notifai.1-activation', 'A'], ['notifai.2-guidance', 'G'], ['notifai.1-activation', 'W']])
  // A Hermes that reports its release through version_info, not __version__.
  expect(runSectionsCase(root, 'fits', { version: '0.0.0', base_version: '0.22.4' }).calls)
    .toEqual([{ event: 'session-start', sections: 2 }, ...TURN_CHECKS])
})

it.skipIf(process.platform === 'win32')('hands in what a session must reload with the next turn, once the CLI says so', () => {
  // Hermes keeps its system prompt, Notifai's sections included, for the
  // whole session, so a change of guidance or a compaction reaches the model
  // only through a turn. The CLI decides and says each once.
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-currency-')); roots.push(root)
  expect(runSectionsCase(root, 'fits', undefined, false, true).turns).toEqual([{ context: 'N' }, { context: 'N' }])
  const child = runSectionsCase(root, 'child-compacted')
  expect(child.calls.filter(call => call.event === 'guidance-check')).toEqual([
    { event: 'guidance-check', sections: null, worker: true },
    { event: 'guidance-check', sections: null, worker: true, compacted: true },
  ])
  const compacted = runSectionsCase(root, 'compacted')
  expect(compacted.turns).toEqual([null, { context: 'C' }])
  expect(compacted.calls.filter((call) => call.event === 'guidance-check'))
    .toEqual([{ event: 'guidance-check', sections: null }, { event: 'guidance-check', sections: null, compacted: true }])
})

it.skipIf(process.platform === 'win32')('renders whichever section fits on its own and adds nothing to later turns', () => {
  // Each section is safe alone (the CLI puts the trust text and topics in the
  // second), so the plugin neither watches for a left-out section nor hands
  // its text in with a turn, which Hermes would keep in history every turn.
  // A turn carries only what the CLI says the session must reload, here nothing.
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-skipped-')); roots.push(root)
  for (const [scenario, rendered] of [
    ['fits', [['notifai.1-activation', 'A'], ['notifai.2-guidance', 'G']]],
    ['activation-left-out', [['notifai.2-guidance', 'G']]],
    ['guidance-left-out', [['notifai.1-activation', 'A']]],
    ['count', []],
  ] as const) {
    const result = runSectionsCase(root, scenario)
    expect(result.rendered, scenario).toEqual(rendered)
    expect(result.turns, scenario).toEqual([null, null])
  }
  // Left out by the section count before Hermes asked: nothing rendered, so
  // no notice was claimed for it.
  expect(runSectionsCase(root, 'count').calls).toEqual(TURN_CHECKS)
})

it.skipIf(process.platform === 'win32')('keeps one section on a Hermes older than the split, an unidentified Hermes, or an earlier CLI', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-one-section-')); roots.push(root)
  for (const hermes of [{ version: '0.20.6' }, { version: null }, { version: '0.0.0' }]) {
    const older = runSectionsCase(root, 'fits', hermes)
    expect(older.rendered, String(hermes.version)).toEqual([['notifai.1-activation', 'O']])
    expect(older.calls, String(hermes.version)).toEqual([{ event: 'session-start', sections: null }, ...TURN_CHECKS])
  }
  // An earlier CLI ignores the request and prints one context sized for one section.
  const earlier = runSectionsCase(root, 'fits', undefined, true)
  expect(earlier.rendered).toEqual([['notifai.1-activation', 'O']])
  expect(earlier.calls).toEqual([{ event: 'session-start', sections: 2 }, ...TURN_CHECKS])
})
