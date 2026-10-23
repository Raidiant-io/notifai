import { mkdirSync,mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe,expect,it } from 'vitest'
import { codexSharedServerState } from './codex-shared-server-health.js'

function home(name = 'h'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nf-css-'))
  const codex = path.join(root, name)
  mkdirSync(codex, { recursive: true })
  return codex
}


describe('codexSharedServerState', () => {
  it('says nothing when Codex cannot be asked', async () => {
    expect(await codexSharedServerState({ CODEX_HOME: home() }, 'darwin', async () => null)).toBeNull()
  })
})
