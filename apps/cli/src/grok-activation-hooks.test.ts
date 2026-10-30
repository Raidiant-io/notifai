import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { hookRunCommand } from './commands-hook-run.js'
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

// Grok shows the model only the first 256 characters of a deny reason, so a
// denied first tool read as Notifai blocking the agent.
it('never denies a Grok tool to deliver activation; the tool result carries it whole', async () => {
  const h = setup()
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify({ ...h.envelope, hook_event_name: 'PreToolUse' }), 'grok')
  expect(h.output).toEqual([])

  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...h.envelope, hook_event_name: 'PostToolUse' }), 'grok')
  expect(h.output).toHaveLength(1)
  const document = JSON.parse(h.output[0]!)
  expect(document.decision).toBeUndefined()
  expect(document.hookSpecificOutput.hookEventName).toBe('PostToolUse')
  expect(document.hookSpecificOutput.additionalContext).toContain('Notifai is enabled for this Project.')
})
