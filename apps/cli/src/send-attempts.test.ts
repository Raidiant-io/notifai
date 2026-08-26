import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NotificationDraftT } from '@raidiant/notifai-protocol'
import type { MachineCredential } from './credentials.js'
import {
  SEND_ATTEMPT_TTL_MS,
  beginSendAttempt,
  semanticMediaIds,
  sendDraftFingerprint,
  settleSendAttempt,
} from './send-attempts.js'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-send-attempt-'))
  roots.push(root)
  const env = { XDG_STATE_HOME: path.join(root, 'state') }
  const credential: MachineCredential = {
    machineId: 'mac_attempt',
    machineName: 'Attempt Machine',
    baseUrl: 'https://app.notifai.test',
    secret: 'private-machine-secret',
  }
  const draft = {
    schema_version: 1,
    kind: 'done',
    project: 'private-project',
    presentation: { title: 'Sensitive result', body: 'Private body text' },
    targets: { mode: 'all' },
  } as NotificationDraftT
  return { root, env, credential, draft }
}

describe('opaque interrupted-send recovery', () => {
  it('matches one exact semantic retry without storing notification content', () => {
    const { env, credential, draft } = fixture()
    const fingerprint = sendDraftFingerprint(draft, credential)
    const first = beginSendAttempt({ env, credential, fingerprint, retry: false, now: 10 })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const files = readdirSync(path.join(env.XDG_STATE_HOME, 'notifai', 'send-attempts'))
    expect(files).toHaveLength(1)
    const file = path.join(env.XDG_STATE_HOME, 'notifai', 'send-attempts', files[0]!)
    const stored = readFileSync(file, 'utf8')
    expect(stored).not.toContain('Sensitive result')
    expect(stored).not.toContain('Private body text')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    if (process.platform !== 'win32') {
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    }

    const retry = beginSendAttempt({ env, credential, fingerprint, retry: true, now: 11 })
    expect(retry).toMatchObject({
      ok: true,
      attemptId: first.attemptId,
      idempotencyKey: first.idempotencyKey,
      replay: true,
    })
    settleSendAttempt(env, first.attemptId)
    expect(beginSendAttempt({ env, credential, fingerprint, retry: true, now: 12 })).toMatchObject({
      ok: false,
      code: 'retry_not_found',
    })
  })

  it('does not follow a symlink presented as an attempt record', () => {
    const { root, env, credential, draft } = fixture()
    if (process.platform === 'win32') return
    const fingerprint = sendDraftFingerprint(draft, credential)
    const first = beginSendAttempt({ env, credential, fingerprint, retry: false, now: 10 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const directory = path.join(env.XDG_STATE_HOME, 'notifai', 'send-attempts')
    const file = path.join(directory, `${first.attemptId}.json`)
    const target = path.join(root, 'foreign.json')
    writeFileSync(target, readFileSync(file, 'utf8'))
    rmSync(file)
    symlinkSync(target, file)

    expect(beginSendAttempt({ env, credential, fingerprint, retry: true, now: 11 })).toMatchObject({
      ok: false,
      code: 'retry_not_found',
    })
    expect(readFileSync(target, 'utf8')).toContain(first.idempotencyKey)
  })

  it('refuses ambiguity instead of choosing between identical unresolved events', () => {
    const { env, credential, draft } = fixture()
    const fingerprint = sendDraftFingerprint(draft, credential)
    beginSendAttempt({ env, credential, fingerprint, retry: false, now: 10 })
    beginSendAttempt({ env, credential, fingerprint, retry: false, now: 11 })
    expect(beginSendAttempt({ env, credential, fingerprint, retry: true, now: 12 })).toMatchObject({
      ok: false,
      code: 'retry_ambiguous',
    })
  })

  it('invalidates attempts after expiry or credential rotation', () => {
    const { env, credential, draft } = fixture()
    const fingerprint = sendDraftFingerprint(draft, credential)
    beginSendAttempt({ env, credential, fingerprint, retry: false, now: 10 })
    expect(
      beginSendAttempt({
        env,
        credential,
        fingerprint,
        retry: true,
        now: 10 + SEND_ATTEMPT_TTL_MS + 1,
      }),
    ).toMatchObject({ ok: false, code: 'retry_not_found' })

    beginSendAttempt({ env, credential, fingerprint, retry: false, now: 20 })
    const rotated = { ...credential, secret: 'rotated-secret' }
    expect(
      beginSendAttempt({
        env,
        credential: rotated,
        fingerprint: sendDraftFingerprint(draft, rotated),
        retry: true,
        now: 21,
      }),
    ).toMatchObject({ ok: false, code: 'retry_not_found' })
  })

  it('fingerprints local media bytes without retaining paths or bytes', () => {
    const { root } = fixture()
    const file = path.join(root, 'private.png')
    writeFileSync(file, 'first bytes')
    const first = semanticMediaIds([file], root)
    writeFileSync(file, 'different bytes')
    const second = semanticMediaIds([file], root)
    expect(first).not.toEqual(second)
    expect(first[0]).not.toContain(file)
    expect(first[0]).not.toContain('first bytes')
  })
})
