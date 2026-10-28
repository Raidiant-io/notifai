import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexTrustFindingsFrom, codexTrustReader, type CodexHookMetadata } from './codex-hooks-list.js'
import { codexHookIdentityHash, type Installation } from './install-hooks.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function installation(): { installation: Installation; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hooks-list-'))
  roots.push(root)
  const home = path.join(root, '.codex')
  mkdirSync(home)
  const file = path.join(home, 'hooks.json')
  writeFileSync(file, '{}')
  const handler = (event: string, role: string) => ({ event, groupIndex: 0, handlerIndex: 0, command: `/x/notifai hook ${role} --harness codex`, timeout: 5 })
  return { env: { CODEX_HOME: home }, installation: { harness: 'codex', file, handlers: [
    handler('Stop', 'stop'), handler('SessionStart', 'session-start'), handler('PreToolUse', 'pre-tool-use'), handler('PostCompact', 'post-compact'),
  ] } }
}

function row(i: Installation, index: number, trustStatus: string, overrides: Partial<CodexHookMetadata> = {}): CodexHookMetadata {
  const handler = i.handlers[index]!
  const event = handler.event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return { key: `${i.file}:${event}:0:0`, eventName: handler.event.charAt(0).toLowerCase() + handler.event.slice(1),
    sourcePath: i.file, enabled: true, currentHash: codexHookIdentityHash(handler), trustStatus, ...overrides }
}

it("reads trust from Codex's own hooks/list, matched by source, event and position", () => {
  const { installation: i, env } = installation()
  const listed = [row(i, 0, 'trusted'), row(i, 1, 'modified'), row(i, 2, 'untrusted'), row(i, 3, 'trusted', { enabled: false })]
  expect(codexTrustFindingsFrom([i], env, listed)).toEqual([
    { file: i.file, event: 'SessionStart', state: 'changed' },
    { file: i.file, event: 'PreToolUse', state: 'new' },
    { file: i.file, event: 'PostCompact', state: 'disabled' },
  ])
})

it("counts a Notifai plugin's hooks by their own rows, and nobody else's", () => {
  const { installation: i, env } = installation()
  const listed = [0, 1, 2, 3].map(index => row(i, index, 'trusted'))
  const plugin = { key: 'plugin:notifai@local:stop:0:0', eventName: 'stop', sourcePath: '/cache/notifai/hooks.json',
    enabled: true, currentHash: 'sha256:x', trustStatus: 'modified' }
  expect(codexTrustFindingsFrom([i], env, [...listed, { ...plugin, pluginId: 'notifai@local' },
    { ...plugin, pluginId: 'someone-else@local' }])).toEqual([{ file: '/cache/notifai/hooks.json', event: 'Stop', state: 'changed' }])
})

it('falls back to config.toml when Codex cannot be asked', async () => {
  const { installation: i, env } = installation()
  const trust = await codexTrustReader([{ env, installations: [i] }], '/', async () => null)
  // No config.toml approvals: every handler is new, exactly as the mirror reads it.
  expect(trust([i], env).map(finding => finding.state)).toEqual(['new', 'new', 'new', 'new'])
  const asked = await codexTrustReader([{ env, installations: [i] }], '/', async () => [0, 1, 2, 3].map(index => row(i, index, 'trusted')))
  expect(asked([i], env)).toEqual([])
})
