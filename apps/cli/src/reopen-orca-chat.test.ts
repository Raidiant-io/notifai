import { describe, expect, it } from 'vitest'
import type { OrcaRuntime } from './orca-runtime.js'
import { orcaChatReach, orcaReopenFacts } from './reopen-orca-chat.js'

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

  it('declines bot and paired-host routes before recording a wake address', () => {
    const env = { ORCA_STRUCTURED_SESSION: '1', ORCA_AGENT_SESSION_ID: CHAT,
      ORCA_CLI_COMMAND: facts.cli, ORCA_USER_DATA_PATH: facts.user_data }
    expect(orcaReopenFacts(env, 'darwin')).toEqual(facts)
    expect(orcaReopenFacts({ ...env, ORCA_BOT_TOOLS_TOKEN: 'synthetic' }, 'darwin')).toBeNull()
    expect(orcaReopenFacts({ ...env, ORCA_ENVIRONMENT: 'paired' }, 'darwin')).toBeNull()
  })
})
