import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaRuntime } from './orca-runtime.js'
import { orcaChatReach, orcaReopenFacts, systemOrcaReopenHost } from './reopen-orca-chat.js'
import { sessionInputWake } from './session-inputs.js'

const CHAT = '11111111-2222-3333-4444-555555555555'
const NATIVE = '22222222-3333-4444-5555-666666666666'
const facts = { chat: CHAT, cli: '/opt/orca/bin/orca', user_data: '/tmp/orca-profile' }

function host({ member = CHAT, native = NATIVE, visible = true, empty = false } = {}): OrcaRuntime {
  return {
    call: async (method) => {
      if (method === 'orchestration.partyLocation') return { ok: true, result: { location: { kind: 'chat', sessionId: member } } }
      if (method === 'agentSession.history') return { ok: true, result: { page: { sessionId: CHAT, fence: 2 },
        ...(empty ? {} : { providerSession: { key: 'session_id', id: native } }) } }
      if (method === 'agent.show') {
        return { ok: true, result: { kind: 'chat', places: visible ? [{ hostId: 'local', agent: 'claude', kind: 'chat', state: 'done' }] : [] } }
      }
      return { ok: false, code: 'unknown_method' }
    },
  }
}

describe('Orca released chat routing', () => {
  it('recognizes the exact native session in a released chat, across independent Orca reads', async () => {
    expect(await orcaChatReach(facts, NATIVE, 'claude-code', host())).toBe('open')
    expect(await orcaChatReach(facts, NATIVE, 'codex', host())).toBe('unavailable')
  })

  it.each([
    ['a /clear successor', { member: 'successor' }, 'replaced'],
    ['a changed provider session', { native: 'successor' }, 'replaced'],
    ['a cleared chat with no provider session yet', { empty: true }, 'empty'],
    ['a closed tab', { visible: false }, 'closed'],
  ] as const)('does not admit %s', async (_name, change, expected) => {
    expect(await orcaChatReach(facts, NATIVE, 'claude-code', host(change))).toBe(expected)
  })

  it('records a wake address for a bot chat but declines paired-host routes', () => {
    const env = { ORCA_STRUCTURED_SESSION: '1', ORCA_AGENT_SESSION_ID: CHAT,
      ORCA_CLI_COMMAND: facts.cli, ORCA_USER_DATA_PATH: facts.user_data }
    expect(orcaReopenFacts(env, 'darwin')).toEqual(facts)
    expect(orcaReopenFacts({ ...env, ORCA_BOT_TOOLS_TOKEN: 'synthetic' }, 'darwin')).toEqual(facts)
    expect(orcaReopenFacts({ ...env, ORCA_ENVIRONMENT: 'paired' }, 'darwin')).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('waking a released Orca chat', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  /** An `orca` CLI that answers mail as Orca 1.4.280 does, and records each invocation. */
  function orcaCli(reply: 'accepted' | 'own-chat'): { cli: string; calls: () => string[] } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'notifai-orca-cli-'))
    dirs.push(dir)
    const log = path.join(dir, 'calls')
    const cli = path.join(dir, 'orca')
    const body = reply === 'accepted'
      ? `printf '%s\\n' '{"ok":true,"result":{"messageId":"msg_1"}}'; exit 0`
      // Orca's refusal of mail a bot's chat sends to itself; nothing is sent.
      : `printf '%s\\n' '{"ok":false,"error":{"code":"runtime_error","message":"You are already in that chat; nothing was sent."}}'; exit 1`
    writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$ORCA_AGENT_SESSION_ID $*" >> '${log}'\n${body}\n`)
    chmodSync(cli, 0o755)
    return { cli, calls: () => { try { return readFileSync(log, 'utf8').trim().split('\n') } catch { return [] } } }
  }

  /** Orca's runtime for that chat: idle, accepting a chat message, or refusing it. */
  function runtime(accept: boolean): { runtime: OrcaRuntime; sent: unknown[] } {
    const sent: unknown[] = []
    return { sent, runtime: { call: async (method, params) => {
      if (method === 'status.get') return { ok: true, result: { capabilities: ['agent-session.structured.v1', 'agent-session.accepted-send.v1'] } }
      if (method === 'agentSession.history') {
        return { ok: true, result: { page: { sessionId: CHAT, fence: 4, latestTurn: { turn: { state: 'completed' } }, submissions: [] } } }
      }
      if (method === 'agentSession.send') {
        sent.push(params)
        return { ok: true, result: accept ? { ok: true } : { ok: false, refusal: { code: 'agent_session_operation_invalid' } } }
      }
      return { ok: false, code: 'unknown_method' }
    } } }
  }

  it("sends a bot's own chat its wake as a chat message when Orca refuses the chat's mail to itself", async () => {
    const orca = orcaCli('own-chat')
    const host = runtime(true)
    const woken = await systemOrcaReopenHost({}, host.runtime).wake({ ...facts, cli: orca.cli }, sessionInputWake())
    expect(woken).toEqual({ outcome: 'sent', detail: 'mail-refused:runtime_error:exit-1;chat-message-sent' })
    expect(orca.calls()).toEqual([`${CHAT} orchestration send --to orca_session_id:${CHAT} --subject Notifai --body ${sessionInputWake()} --json`])
    expect(host.sent).toEqual([expect.objectContaining({
      envelope: expect.objectContaining({ sessionId: CHAT, expectedRuntimeFence: 4 }),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: sessionInputWake() }] },
    })])
  })

  it('keeps mail for a chat that accepts it, and sends nothing else', async () => {
    const orca = orcaCli('accepted')
    const host = runtime(true)
    expect(await systemOrcaReopenHost({}, host.runtime).wake({ ...facts, cli: orca.cli }, sessionInputWake()))
      .toEqual({ outcome: 'sent', detail: 'mail' })
    expect(host.sent).toEqual([])
  })

  it('reports why each route refused when neither takes the wake', async () => {
    const orca = orcaCli('own-chat')
    expect(await systemOrcaReopenHost({}, runtime(false).runtime).wake({ ...facts, cli: orca.cli }, sessionInputWake()))
      .toEqual({ outcome: 'refused', detail: 'mail-refused:runtime_error:exit-1;chat-message-not-sent' })
  })
})
