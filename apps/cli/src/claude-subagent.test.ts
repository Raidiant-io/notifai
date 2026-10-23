import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeAskingSubagent } from './claude-subagent.js'

const SESSION = '3c0d5e6f-1111-4222-8333-944455556666'

/** A Claude Code config dir holding one session's transcript and its subagents' transcripts. */
function transcripts() {
  const config = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-subagent-'))
  const project = path.join(config, 'projects', '-work-project')
  const subagents = path.join(project, SESSION, 'subagents')
  mkdirSync(subagents, { recursive: true })
  const line = (value: unknown): string => `${JSON.stringify(value)}\n`
  return {
    env: { CLAUDE_CONFIG_DIR: config } as NodeJS.ProcessEnv,
    call: (id: string, command: string): string => line({ type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }),
    result: (id: string): string => line({ type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] } }),
    root: (...lines: string[]): void => writeFileSync(path.join(project, `${SESSION}.jsonl`), lines.join('')),
    agent: (id: string, meta: Record<string, unknown>, ...lines: string[]): void => {
      writeFileSync(path.join(subagents, `agent-${id}.jsonl`), lines.join(''))
      writeFileSync(path.join(subagents, `agent-${id}.meta.json`), JSON.stringify(meta))
    },
  }
}

const ASK = 'notifai ask "Which headline should v2 use?" --choice "Faster sync" --choice "Offline mode"'

describe('claudeAskingSubagent', () => {
  it('names the running subagent whose notifai ask is waiting for its result', () => {
    const t = transcripts()
    t.root(t.call('toolu_root', 'git status'), t.result('toolu_root'))
    t.agent('a1b2c3', { agentType: 'general-purpose', description: 'headline worker', finished: false },
      t.call('toolu_ls', 'ls'), t.result('toolu_ls'), t.call('toolu_ask', ASK))
    t.agent('d4e5f6', { agentType: 'Explore', description: 'reader', finished: false }, t.call('toolu_cat', 'cat a.md'))
    expect(claudeAskingSubagent(SESSION, t.env, ['Which headline should v2 use?']))
      .toEqual({ agent_id: 'a1b2c3', agent_type: 'general-purpose', description: 'headline worker' })
  })

  it('names nobody when the root is asking, the subagent finished, or its call already returned', () => {
    const rootAsking = transcripts()
    rootAsking.root(rootAsking.call('toolu_root', ASK))
    rootAsking.agent('a1', { finished: false }, rootAsking.call('toolu_ask', ASK))
    expect(claudeAskingSubagent(SESSION, rootAsking.env, ['Which headline should v2 use?'])).toBeUndefined()

    const finished = transcripts()
    finished.agent('a1', { finished: true }, finished.call('toolu_ask', ASK))
    expect(claudeAskingSubagent(SESSION, finished.env, ['Which headline should v2 use?'])).toBeUndefined()

    const returned = transcripts()
    returned.agent('a1', { finished: false }, returned.call('toolu_ask', ASK), returned.result('toolu_ask'))
    expect(claudeAskingSubagent(SESSION, returned.env, ['Which headline should v2 use?'])).toBeUndefined()
  })

  it('tells two asking subagents apart by the question, and names nobody when that does not decide', () => {
    const t = transcripts()
    t.agent('a1', { agentType: 'general-purpose', finished: false }, t.call('toolu_1', ASK))
    t.agent('a2', { agentType: 'general-purpose', finished: false }, t.call('toolu_2', 'notifai ask "Ship it to production now?"'))
    expect(claudeAskingSubagent(SESSION, t.env, ['Ship it to production now?'])?.agent_id).toBe('a2')
    expect(claudeAskingSubagent(SESSION, t.env, ['Something else entirely?'])).toBeUndefined()
  })

  it('reads past lines it cannot parse, and refuses a session id that names a path', () => {
    const t = transcripts()
    t.agent('a1', { finished: false }, '{not json\n', t.call('toolu_ask', ASK))
    expect(claudeAskingSubagent(SESSION, t.env, [])?.agent_id).toBe('a1')
    expect(claudeAskingSubagent('../escape', t.env, [])).toBeUndefined()
    expect(claudeAskingSubagent(SESSION, { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'notifai-no-such-config') }, [])).toBeUndefined()
  })
})
