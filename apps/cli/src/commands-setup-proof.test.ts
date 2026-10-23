import { mkdtempSync,readFileSync,readdirSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import {
readSetupProof,
writeSetupProof
} from './commands-setup-proof.js'
import type { MachineCredential } from './credentials.js'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function deps(root: string, cwd: string, credential: MachineCredential): CommandDeps {
  return {
    cwd,
    env: { XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') },
    io: { out: () => {}, err: () => {}, confirm: async () => false, openUrl: () => {} },
    store: {
      load: () => credential,
      save: () => {},
      clear: () => {},
      describe: () => 'test',
    },
  }
}

describe('stable setup delivery proof identity', () => {
  it('loads a pre-observation record as canonical unknown without rewriting it', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-proof-pre-observation-'))
    roots.push(root)
    const commandDeps = deps(root, root, {
      machineId: 'mac_one',
      machineName: 'One',
      baseUrl: 'https://app.notifai.test',
      secret: 'approval-one',
    })
    const provenance = {
      request_id: 'req_proof',
      device_id: 'dev_one',
      started_at: '2026-08-26T00:00:00.000Z',
    }
    expect(writeSetupProof(commandDeps, {
      ...provenance,
      companion_receipt: { state: 'unknown', observed_at: null },
    })).toBe(true)
    const proofDir = path.join(root, 'state', 'notifai', 'machine-proofs')
    const file = path.join(proofDir, readdirSync(proofDir)[0]!)
    const stored = readFileSync(file, 'utf8')
    expect(JSON.parse(stored)).toEqual(provenance)

    expect(readSetupProof(commandDeps)).toEqual({
      ...provenance,
      companion_receipt: { state: 'unknown', observed_at: null },
    })
    expect(readFileSync(file, 'utf8')).toBe(stored)
  })
})
