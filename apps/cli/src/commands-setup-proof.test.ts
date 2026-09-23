import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
      started_at: '2026-08-26T00:00:00.000Z',
      companion_receipt: { state: 'unknown', observed_at: null },
    })).toBe(true)
    const proofDir = path.join(root, 'state', 'notifai', 'machine-proofs')
    const file = path.join(proofDir, readdirSync(proofDir)[0]!)
    writeFileSync(file, `${JSON.stringify({
      request_id: 'req_proof',
      device_id: 'dev_one',
      started_at: '2026-08-26T00:00:00.000Z',
      companion_receipt: { state: 'observed', observed_at: null },
    })}\n`)

    expect(readSetupProof(commandDeps)).toBeNull()
  })

  it('is one proof per machine, shared by every Project and checkout', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-proof-identity-'))
    roots.push(root)
    const credential = {
      machineId: 'mac_one',
      machineName: 'One',
      baseUrl: 'https://app.notifai.test',
      secret: 'approval-one',
    }
    const first = deps(root, path.join(root, 'project-a'), credential)
    const second = deps(root, path.join(root, 'project-b'), credential)
    const proof = {
      request_id: 'req_proof',
      device_id: 'dev_one',
      started_at: '2026-08-26T00:00:00.000Z',
      companion_receipt: { state: 'observed' as const, observed_at: '2026-08-26T00:00:02.000Z' },
    }
    expect(writeSetupProof(first, proof)).toBe(true)
    expect(readSetupProof(second)).toEqual(proof)
  })

  it('removes superseded per-Project proofs once a machine proof is written', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-proof-legacy-'))
    roots.push(root)
    const legacy = path.join(root, 'state', 'notifai', 'setup-proofs')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(path.join(legacy, 'old.json'), '{}\n')
    expect(writeSetupProof(deps(root, root, {
      machineId: 'mac_one',
      machineName: 'One',
      baseUrl: 'https://app.notifai.test',
      secret: 'approval-one',
    }), {
      request_id: 'req_proof',
      device_id: 'dev_one',
      started_at: '2026-08-26T00:00:00.000Z',
      companion_receipt: { state: 'observed', observed_at: '2026-08-26T00:00:02.000Z' },
    })).toBe(true)
    expect(existsSync(legacy)).toBe(false)
  })

  it('invalidates on service, machine approval, or machine change, but not device change once observed', () => {
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
      started_at: '2026-08-26T00:00:00.000Z',
      companion_receipt: { state: 'observed', observed_at: '2026-08-26T00:00:02.000Z' },
    })).toBe(true)
    expect(readSetupProof(deps(root, root, { ...credential, baseUrl: 'https://other.test' }))).toBeNull()
    expect(readSetupProof(deps(root, root, { ...credential, machineId: 'mac_two' }))).toBeNull()
    expect(readSetupProof(deps(root, root, { ...credential, secret: 'approval-two' }))).toBeNull()
    expect(setupProofApplies(readSetupProof(original), ['dev_two'])).toBe(true)
  })

  it('keeps an unobserved proof only while its device is ready', () => {
    const proof = {
      request_id: 'req_proof',
      device_id: 'dev_one',
      started_at: '2026-08-26T00:00:00.000Z',
      companion_receipt: { state: 'unknown' as const, observed_at: null },
    }
    expect(setupProofApplies(proof, ['dev_one'])).toBe(true)
    expect(setupProofApplies(proof, ['dev_two'])).toBe(false)
  })
})
