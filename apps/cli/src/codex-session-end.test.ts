import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyCodexSessionEnd,
  codexDormantSurface,
  codexHostKind,
  codexHostKindOf,
  codexTranscriptState,
  readCodexThreadOriginator,
  type CodexEndEvidence,
} from './codex-session-end.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function rollout(originator: string, instructions = 'short'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-end-'))
  roots.push(root)
  const file = path.join(root, 'rollout.jsonl')
  writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 't', originator, source: 'vscode', base_instructions: instructions } })}\n` +
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`)
  return file
}

describe('Codex SessionEnd classification', () => {
  const app: CodexEndEvidence = { transcript: 'present', host: 'alive', originator: 'Codex Desktop', hostKind: 'app-server' }

  it.each<[string, CodexEndEvidence, ReturnType<typeof classifyCodexSessionEnd>]>([
    ['an archived or deleted conversation is closed', { ...app, transcript: 'missing' }, { state: 'ended', reason: 'session-archived' }],
    ['a quit app (its server gone) closes the conversation', { ...app, host: 'gone' }, { state: 'ended', reason: 'harness-gone' }],
    ['an app conversation unloaded while the app runs stays open', app, { state: 'dormant-open', surface: 'app' }],
    ['so does one from the newer Codex app', { ...app, originator: 'codex_work_desktop' }, { state: 'dormant-open', surface: 'app' }],
    ['and one from the IDE extension', { ...app, originator: 'codex_vscode' }, { state: 'dormant-open', surface: 'ide' }],
    ['a CLI conversation unloaded by the shared server is closed', { ...app, originator: 'codex-tui', hostKind: 'shared-server' }, { state: 'ended', reason: 'session-end-hook' }],
    ['so is an app conversation the shared server hosts', { ...app, hostKind: 'shared-server' }, { state: 'ended', reason: 'session-end-hook' }],
    ['even when it looks like an app-server', { ...app, originator: 'codex-tui' }, { state: 'ended', reason: 'session-end-hook' }],
    ['an app conversation a terminal took over and closed is closed', { ...app, hostKind: 'other' }, { state: 'ended', reason: 'session-end-hook' }],
    ['another app-server client is closed', { ...app, originator: 'orca_desktop' }, { state: 'ended', reason: 'session-end-hook' }],
    ['an unreadable originator is closed', { ...app, originator: null }, { state: 'ended', reason: 'session-end-hook' }],
    ['an unknown host is closed', { ...app, hostKind: 'unknown' }, { state: 'ended', reason: 'session-end-hook' }],
    ['archive wins over everything', { ...app, transcript: 'missing', host: 'gone' }, { state: 'ended', reason: 'session-archived' }],
  ])('%s', (_name, evidence, verdict) => {
    expect(classifyCodexSessionEnd(evidence)).toEqual(verdict)
  })

  it('names only the app and IDE originators as surfaces that keep a conversation open', () => {
    expect(codexDormantSurface('Codex Desktop')).toBe('app')
    expect(codexDormantSurface('codex_vscode')).toBe('ide')
    for (const other of ['codex-tui', 'codex_exec', 'orca_desktop', 'T3 Code', null]) expect(codexDormantSurface(other)).toBeNull()
  })

  it('reads the originator from the rollout\'s first line, however long its instructions', () => {
    expect(readCodexThreadOriginator(rollout('Codex Desktop'))).toBe('Codex Desktop')
    expect(readCodexThreadOriginator(rollout('codex-tui', 'x'.repeat(300_000)))).toBe('codex-tui')
  })

  it('reads no originator from a missing, empty or foreign file', () => {
    expect(readCodexThreadOriginator(undefined)).toBeNull()
    expect(readCodexThreadOriginator(path.join(os.tmpdir(), 'notifai-no-such-rollout.jsonl'))).toBeNull()
    const file = rollout('Codex Desktop')
    writeFileSync(file, '{"type":"event_msg","payload":{"originator":"Codex Desktop"}}\n')
    expect(readCodexThreadOriginator(file)).toBeNull()
    writeFileSync(file, '')
    expect(readCodexThreadOriginator(file)).toBeNull()
  })

  it('tells a present rollout from a moved one, and knows when none was named', () => {
    const file = rollout('Codex Desktop')
    expect(codexTranscriptState(file)).toBe('present')
    rmSync(file)
    expect(codexTranscriptState(file)).toBe('missing')
    expect(codexTranscriptState(undefined)).toBe('unknown')
  })

  it('does not take an ordinary process for an app-server', () => {
    expect(codexHostKind(process.pid)).toBe(process.platform === 'win32' ? 'unknown' : 'other')
  })

  // Command lines as `ps -o args=` printed them on macOS with Codex 0.163.0.
  it.each([
    ['the shared server', '/Users/u/.codex/packages/app-server-daemon/releases/0.163.0-aarch64-apple-darwin/bin/codex app-server --listen unix:// --analytics-default-enabled --managed-daemon', 'shared-server'],
    ['a server listening on a socket', 'codex app-server --listen=ws://127.0.0.1:4500', 'shared-server'],
    ['the Codex app\'s own server', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true', 'app-server'],
    ['a terminal hosting its own thread', '/opt/homebrew/bin/codex --no-daemon', 'other'],
    ['a plain terminal', 'codex', 'other'],
    ['nothing', '', 'unknown'],
  ] as const)('classifies %s', (_name, args, kind) => {
    expect(codexHostKindOf(args)).toBe(kind)
  })
})
