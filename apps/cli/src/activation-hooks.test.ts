import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { hookRunCommand } from './commands-hook-run.js'
import { HOOK_INSTALLABLE_HARNESSES } from './harnesses.js'
import { enableProject, projectBinding } from './project-enablement.js'

const SESSION = '33333333-3333-4333-8333-333333333333'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-grok-activation-'))
  roots.push(root)
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'),
    GROK_HOME: path.join(root, 'home', '.grok') }
  execFileSync('git', ['init', '-q'], { cwd: root })
  enableProject(projectBinding(root, env)!)
  const output: string[] = []
  const deps: CommandDeps = {
    cwd: root, env, hookAdapterHome: env.HOME,
    io: { out: line => { output.push(line) }, err: () => {}, confirm: async () => false, openUrl: () => {} },
    store: { load: () => null, save: () => {}, clear: () => {} } as unknown as CommandDeps['store'],
  }
  const envelope = { sessionId: SESSION, cwd: root, toolName: 'read_file', toolInput: { target_file: 'file.txt' } }
  return { deps, envelope, output }
}

// With no User input waiting, hook output can add context but cannot decide
// whether a prompt, tool or turn may proceed. Include Stop before the first
// tool so an already-spent activation receipt cannot mask a blocking fallback.
it.each(HOOK_INSTALLABLE_HARNESSES)('keeps activation passive across the %s hook lifecycle', async harness => {
  const h = setup()
  const envelope = { ...h.envelope, session_id: SESSION, promptId: 'first', prompt: 'Hello' }
  for (const [event, native] of [
    ['session-start', 'SessionStart'], ['user-prompt-submit', 'UserPromptSubmit'], ['stop', 'Stop'],
    ['pre-tool-use', 'PreToolUse'], ['post-tool-use', 'PostToolUse'],
  ] as const) {
    h.output.length = 0
    const result = await hookRunCommand(h.deps, event, async () => JSON.stringify({
      ...envelope, hook_event_name: native, reason: 'end_turn',
    }), harness)
    expect(result).toBe(0)
    if (event === 'stop' || (harness === 'grok' && event !== 'post-tool-use')) {
      expect(h.output).toEqual([])
    }
    for (const line of h.output) {
      if (['hermes', 'opencode', 'openclaw'].includes(harness)) {
        // These adapters insert hook stdout as prompt text.
        expect(line).not.toMatch(/^\s*\{/)
      } else if (harness === 'cursor') {
        expect(JSON.parse(line)).toEqual({ additional_context: expect.any(String) })
      } else {
        expect(JSON.parse(line)).toEqual({
          hookSpecificOutput: { hookEventName: native, additionalContext: expect.any(String) },
        })
      }
    }
    if (harness === 'grok' && event === 'post-tool-use') {
      expect(h.output).toHaveLength(1)
      expect(JSON.parse(h.output[0]!).hookSpecificOutput.additionalContext).toContain('Notifai is enabled for this Project.')
    }
  }
})
