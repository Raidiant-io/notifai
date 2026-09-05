import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import type { MachineCredential } from './credentials.js'
import {
  readSetupProof,
  setupProofApplies,
  writeSetupProof,
} from './commands-setup-proof.js'

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
      project: 'project',
      started_at: '2026-08-26T00:00:00.000Z',
    }
    expect(writeSetupProof(commandDeps, {
      ...provenance,
      companion_receipt: { state: 'unknown', observed_at: null },
    })).toBe(true)
    const proofDir = path.join(root, 'state', 'notifai', 'setup-proofs')
    const file = path.join(proofDir, readdirSync(proofDir)[0]!)
    const stored = readFileSync(file, 'utf8')
    expect(JSON.parse(stored)).toEqual(provenance)

    expect(readSetupProof(commandDeps, 'project')).toEqual({
      ...provenance,
      companion_receipt: { state: 'unknown', observed_at: null },
    })
    expect(readFileSync(file, 'utf8')).toBe(stored)
  })

  it('keeps a malformed Companion Receipt outcome incomplete', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-proof-malformed-receipt-'))
    roots.push(root)
    const commandDeps = deps(root, root, {
      machineId: 'mac_one',
      machineName: 'One',
      baseUrl: 'https://app.notifai.test',
      secret: 'approval-one',
    })
    expect(writeSetupProof(commandDeps, {
      request_id: 'req_proof',
      device_id: 'dev_one',
      project: 'project',
      started_at: '2026-08-26T00:00:00.000Z',
      companion_receipt: { state: 'unknown', observed_at: null },
    })).toBe(true)
    const proofDir = path.join(root, 'state', 'notifai', 'setup-proofs')
    const file = path.join(proofDir, readdirSync(proofDir)[0]!)
    writeFileSync(file, `${JSON.stringify({
      request_id: 'req_proof',
      device_id: 'dev_one',
      project: 'project',
      started_at: '2026-08-26T00:00:00.000Z',
      companion_receipt: { state: 'observed', observed_at: null },
    })}\n`)

    expect(readSetupProof(commandDeps, 'project')).toBeNull()
  })

  it('is shared by linked checkouts of one Project and separated by Project', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-proof-identity-'))
    roots.push(root)
    const credential = {
      machineId: 'mac_one',
      machineName: 'One',
      baseUrl: 'https://app.notifai.test',
      secret: 'approval-one',
    }
    const first = deps(root, path.join(root, 'worktree-a'), credential)
    const second = deps(root, path.join(root, 'worktree-b'), credential)
    const proof = {
      request_id: 'req_proof',
      device_id: 'dev_one',
      project: 'shared-project',
      started_at: '2026-08-26T00:00:00.000Z',
      companion_receipt: { state: 'observed' as const, observed_at: '2026-08-26T00:00:02.000Z' },
    }
    expect(writeSetupProof(first, proof)).toBe(true)
    expect(readSetupProof(second, 'shared-project')).toEqual(proof)
    expect(readSetupProof(second, 'different-project')).toBeNull()
  })

  it('invalidates on service, machine approval, machine, or device change', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-proof-invalidation-'))
    roots.push(root)
    const credential = {
      machineId: 'mac_one',
      machineName: 'One',
      baseUrl: 'https://app.notifai.test',
      secret: 'approval-one',
    }
    const original = deps(root, root, credential)
    expect(writeSetupProof(original, {
      request_id: 'req_proof',
      device_id: 'dev_one',
      project: 'project',
      started_at: '2026-08-26T00:00:00.000Z',
      companion_receipt: { state: 'observed', observed_at: '2026-08-26T00:00:02.000Z' },
    })).toBe(true)
    expect(readSetupProof(deps(root, root, { ...credential, baseUrl: 'https://other.test' }), 'project')).toBeNull()
    expect(readSetupProof(deps(root, root, { ...credential, machineId: 'mac_two' }), 'project')).toBeNull()
    expect(readSetupProof(deps(root, root, { ...credential, secret: 'approval-two' }), 'project')).toBeNull()
    expect(setupProofApplies(readSetupProof(original, 'project'), 'project', ['dev_two'])).toBe(false)
  })
})
