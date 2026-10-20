import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_CARD_VERSION_FLOOR, codexCardToolOffered, codexCardVersionVerdict } from './codex-card-capability.js'
import { readNativeTurnModel } from './codex-native-turn.js'

it('pins the card floor to the Codex release the card round trip was reproduced on', () => {
  expect(CODEX_CARD_VERSION_FLOOR).toBe('0.163.0')
})

it.each([
  ['0.163.0', true],
  ['v0.163.0', true],
  ['0.163.1', true],
  ['0.164.0', true],
  ['0.164.0-alpha.1', true],
  ['1.0.0', true],
  ['0.163.0+build.7', true],
  ['0.162.0', false],
  ['0.162.99', false],
  ['0.9.9', false],
  ['0.163.0-alpha.3', false],
])('compares %s against the floor by SemVer precedence: supported %s', (version, supported) => {
  const verdict = codexCardVersionVerdict(version)
  expect(verdict.supported).toBe(supported)
  expect(verdict.version).toBe(version)
  if (!verdict.supported) expect(verdict.reason).toBe('below_floor')
})

it.each([undefined, null, '', '   ', 42, 'latest', '0.163', 'codex-cli 0.163.0'])('fails closed on a missing or unparseable version: %j', version => {
  const verdict = codexCardVersionVerdict(version)
  expect(verdict.supported).toBe(false)
  if (!verdict.supported) expect(verdict.reason).toBe('unknown_version')
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

  it('needs the callback itself: hooks on disk are not proof', () => {
    const { env } = transcript(turn('t1', 'gpt-6-sol'))
    expect(codexCardToolOffered({}, OWNER, SESSION, env)).toBe(false)
  })

  it('belongs to one owner: a resumed or replaced process proves it again', () => {
    const { env, file } = transcript(turn('t1', 'gpt-6-sol'))
    expect(codexCardToolOffered({ codex_card_tool: { key: 'owner-0', model: 'gpt-6-sol', transcript_path: file } }, OWNER, SESSION, env)).toBe(false)
  })

  it('lapses when the conversation moves to a model without the card', () => {
    const { env, file } = transcript([...turn('t1', 'gpt-6-sol'), ...turn('t2', 'gpt-5.5')])
    expect(readNativeTurnModel(file, SESSION, env)).toBe('gpt-5.5')
    expect(codexCardToolOffered({ codex_card_tool: { key: OWNER, model: 'gpt-6-sol', transcript_path: file } }, OWNER, SESSION, env)).toBe(false)
  })

  it('reads only real turn context records, never quoted ones', () => {
    const quoted = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1',
      output: JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol' } }) } }
    const { env, file } = transcript([...turn('t1', 'gpt-5.5'), quoted])
    expect(readNativeTurnModel(file, SESSION, env)).toBe('gpt-5.5')
    expect(codexCardToolOffered({ codex_card_tool: { key: OWNER, model: 'gpt-6-sol', transcript_path: file } }, OWNER, SESSION, env)).toBe(false)
  })

  it.each([
    ['another session', () => transcript(turn('t1', 'gpt-6-sol'), '44444444-4444-4444-8444-444444444444')],
    ['no turn context', () => transcript([{ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }])],
  ])('fails closed on %s', (_name, make) => {
    const { env, file } = make()
    expect(readNativeTurnModel(file, SESSION, env)).toBeNull()
    expect(codexCardToolOffered({ codex_card_tool: { key: OWNER, model: 'gpt-6-sol', transcript_path: file } }, OWNER, SESSION, env)).toBe(false)
  })

  it('fails closed on a transcript outside the Codex home', () => {
    const { env } = transcript(turn('t1', 'gpt-6-sol'))
    const outside = path.join(env.HOME, 'elsewhere.jsonl')
    writeFileSync(outside, [{ type: 'session_meta', payload: { id: SESSION, source: 'cli' } }, ...turn('t1', 'gpt-6-sol')]
      .map(record => JSON.stringify(record) + '\n').join(''))
    expect(codexCardToolOffered({ codex_card_tool: { key: OWNER, model: 'gpt-6-sol', transcript_path: outside } }, OWNER, SESSION, env)).toBe(false)
  })
})
