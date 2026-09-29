import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openclawGatewayReady } from './openclaw-gateway-readiness.js'
import { currentProcessIdentity } from './process-identity.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('rejects an absent, replaced, or dead Gateway service before ask admission', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-ready-'))
  roots.push(root)
  const env = { OPENCLAW_STATE_DIR: root }
  const identity = currentProcessIdentity()
  expect(identity).not.toBeNull()
  if (identity === null) return
  const script = path.join(root, 'openclaw.mjs')
  writeFileSync(script, 'original')
  const dir = path.join(root, 'notifai')
  mkdirSync(dir)
  const marker = path.join(dir, 'continuation-ready.json')
  expect(openclawGatewayReady(env)).toBe(false)
  const ready = { ...identity, script, script_mtime: statSync(script).mtimeMs }
  writeFileSync(marker, JSON.stringify(ready))
  expect(openclawGatewayReady(env)).toBe(true)
  writeFileSync(marker, JSON.stringify({ ...ready, start: 'stale process' }))
  expect(openclawGatewayReady(env)).toBe(false)
  writeFileSync(marker, JSON.stringify(ready))
  writeFileSync(script, `${readFileSync(script, 'utf8')} changed`)
  expect(openclawGatewayReady(env)).toBe(false)
})
