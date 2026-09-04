import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stopShapeProblems } from './commands-hook-shape.js'
import { findInstallations, QUESTION_STOP_TIMEOUT_SECONDS, type Installation } from './install-hooks.js'

function installation(harness: Installation['harness'], async: boolean, timeout?: number): Installation {
  return {
    harness,
    file: '/isolated/hooks.json',
    handlers: [{
      event: 'Stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: `'/isolated/hook-adapter' hook stop --owner notifai --harness ${harness}`,
      async,
      ...(timeout === undefined ? {} : { timeout }),
    }],
  }
}

describe('Stop continuation lifetime admission', () => {
  it.each([undefined, 1])('does not reject detached Claude for timeout %s that the host does not enforce', (timeout) => {
    // Claude's ordinary async hooks are not killed by timeout once backgrounded.
    // The Notifai waiter still owns its independently bounded answer window.
    expect(stopShapeProblems(installation('claude-code', true, timeout), 'darwin')).toEqual([])
  })

  it.each(['codex', 'claude-code'] as const)('requires a full-window budget for blocking %s on Windows', (harness) => {
    expect(stopShapeProblems(installation(harness, false, 1), 'win32')).toHaveLength(1)
    expect(stopShapeProblems(installation(harness, false, QUESTION_STOP_TIMEOUT_SECONDS), 'win32')).toEqual([])
  })

  it('still rejects a blocking Claude handler for the POSIX detached route', () => {
    expect(stopShapeProblems(installation('claude-code', false, QUESTION_STOP_TIMEOUT_SECONDS), 'linux'))
      .toEqual([expect.stringContaining('needs `async: true`')])
  })

  it('rejects asyncRewake rather than treating its enforced timeout as ordinary async', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-async-rewake-'))
    const handler = installation('claude-code', true, 1).handlers[0]!
    writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: handler.command, async: true, asyncRewake: true, timeout: 1 }] }] },
    }))
    const installed = findInstallations({ ...process.env, CLAUDE_CONFIG_DIR: root })
      .find((entry) => entry.harness === 'claude-code')!
    expect(installed).toBeDefined()
    expect(stopShapeProblems(installed, 'darwin'))
      .toEqual([expect.stringContaining('enables `asyncRewake`')])
  })
})
