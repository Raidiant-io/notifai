import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import { CODEX_CARD_VERSION_FLOOR,codexCardToolOffered } from './codex-card-capability.js'
import { readNativeTurnModel } from './codex-native-turn.js'

it('pins the card floor to the Codex release the card round trip was reproduced on', () => {
  expect(CODEX_CARD_VERSION_FLOOR).toBe('0.163.0')
})

describe('whether this session can call the card', () => {
  const SESSION = '33333333-3333-4333-8333-333333333333'
  const OWNER = 'owner-1'
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  function transcript(records: unknown[], id = SESSION) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-card-tool-'))
    roots.push(root)
    const env = { HOME: root, CODEX_HOME: path.join(root, 'codex') }
    const file = path.join(env.CODEX_HOME, 'sessions', '2026', `rollout-${id}.jsonl`)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, [{ type: 'session_meta', payload: { id, source: 'cli' } }, ...records]
      .map(record => JSON.stringify(record) + '\n').join(''))
    return { env, file }
  }
  const turn = (turnId: string, model: string) => [
    { type: 'turn_context', payload: { turn_id: turnId, model } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
  ]

  it('holds for the owner whose card callback ran under the model the current turn runs', () => {
    const { env, file } = transcript([...turn('t1', 'gpt-6-sol'), ...turn('t2', 'gpt-6-sol')])
    expect(readNativeTurnModel(file, SESSION, env)).toBe('gpt-6-sol')
    expect(codexCardToolOffered({ codex_card_tool: { key: OWNER, model: 'gpt-6-sol', transcript_path: file } }, OWNER, SESSION, env)).toBe(true)
  })

  it('reads only real turn context records, never quoted ones', () => {
    const quoted = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1',
      output: JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol' } }) } }
    const { env, file } = transcript([...turn('t1', 'gpt-5.5'), quoted])
    expect(readNativeTurnModel(file, SESSION, env)).toBe('gpt-5.5')
    expect(codexCardToolOffered({ codex_card_tool: { key: OWNER, model: 'gpt-6-sol', transcript_path: file } }, OWNER, SESSION, env)).toBe(false)
  })
})
