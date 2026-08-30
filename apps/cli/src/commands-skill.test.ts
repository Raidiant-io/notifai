import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { skillReadiness } from './commands-skill.js'

describe('development CLI skill parity', () => {
  it('reports an exact gap instead of calling a stale released skill ready', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-dev-skill-'))
    const installedPath = path.join(root, 'skills', 'notifai')
    mkdirSync(installedPath, { recursive: true })
    writeFileSync(path.join(installedPath, 'SKILL.md'), '# stale released skill\n')
    const deps = {
      cwd: root,
      env: {},
      io: { out() {}, err() {}, confirm: async () => false, openUrl() {} },
      store: { load: () => null, save() {}, clear() {}, describe: () => 'test' },
      nativeSkills: {
        list: async (scope: 'project' | 'global') => ({
          skills: scope === 'global'
            ? [{ name: 'notifai', scope, path: installedPath, source: null, sourceType: null, sourceUrl: null, ref: null }]
            : [],
        }),
        add: async () => 0,
        remove: async () => 0,
      },
    } satisfies CommandDeps

    const state = await skillReadiness(deps)
    expect(state).toMatchObject({
      status: 'gap',
      technical: {
        resolution: 'development-cli-skill-mismatch',
        ref: null,
        checkout_digest: expect.stringMatching(/^sha256:/),
        installed_digest: expect.stringMatching(/^sha256:/),
      },
    })
    expect(state.remedy).toBeUndefined()
  })
})
