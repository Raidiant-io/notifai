import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { hookRunCommand } from './commands-hook-run.js'
import { readSessionIncarnation, readSessionState } from './hook-session-state.js'
import type { CommandDeps } from './commands-core.js'

it('records every native Cursor prompt so a held Stop loses write authority', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-cursor-prompt-'))
  try {
    let now = Date.now()
    const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
    const deps: CommandDeps = { env, cwd: root, hookAdapterHome: root, now: () => now,
      io: { out: vi.fn(), err: vi.fn(), confirm: async () => false, openUrl: () => {} },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test' } }
    const invoke = () => hookRunCommand(deps, 'user-prompt-submit', async () => JSON.stringify({ conversation_id: 'cursor-test', workspace_roots: [root], hook_event_name: 'beforeSubmitPrompt', prompt: 'next turn' }), 'cursor')
    expect(await invoke()).toBe(0)
    expect(readSessionIncarnation('cursor-test', env)).not.toBeNull()
    expect(readSessionState('cursor-test', env).last_prompt_at).toBe(now)
    now += 5000
    expect(await invoke()).toBe(0)
    expect(readSessionState('cursor-test', env).last_prompt_at).toBe(now)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
