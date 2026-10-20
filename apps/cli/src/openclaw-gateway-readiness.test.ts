import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { sourceIntegrationRevision } from './integration-revision.js'
import { openclawGatewayReady } from './openclaw-gateway-readiness.js'
import { openclawPluginSource } from './openclaw-plugin.js'
import { currentProcessIdentity } from './process-identity.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-ready-'))
  roots.push(root)
  const env = { OPENCLAW_STATE_DIR: root }
  const identity = currentProcessIdentity()
  if (identity === null) throw new Error('process identity unavailable')
  const script = path.join(root, 'openclaw.mjs')
  writeFileSync(script, 'original')
  mkdirSync(path.join(root, 'notifai'))
  const plugin = path.join(root, 'extensions', 'notifai', 'index.js')
  mkdirSync(path.dirname(plugin), { recursive: true })
  const install = (adapterPath: string) => {
    const source = openclawPluginSource({ adapterPath, timeoutSeconds: 15, integrationScope: plugin })
    writeFileSync(plugin, source)
    return sourceIntegrationRevision(source)!
  }
  return { root, env, identity, script, marker: path.join(root, 'notifai', 'continuation-ready.json'), install }
}

it('rejects an absent, replaced, or dead Gateway service before ask admission', () => {
  const { env, identity, script, marker, install } = fixture()
  const revision = install('/opt/notifai/bin/notifai')
  expect(openclawGatewayReady(env)).toBe(false)
  const ready = { ...identity, script, script_mtime: statSync(script).mtimeMs, integration_revision: revision }
  writeFileSync(marker, JSON.stringify(ready))
  expect(openclawGatewayReady(env)).toBe(true)
  writeFileSync(marker, JSON.stringify({ ...ready, start: 'stale process' }))
  expect(openclawGatewayReady(env)).toBe(false)
  writeFileSync(marker, JSON.stringify(ready))
  writeFileSync(script, `${readFileSync(script, 'utf8')} changed`)
  expect(openclawGatewayReady(env)).toBe(false)
})

it('routes only through the plugin generation that matches the installed plugin', () => {
  const { env, identity, script, marker, install } = fixture()
  const loaded = install('/opt/notifai/bin/notifai')
  const ready = { ...identity, script, script_mtime: statSync(script).mtimeMs, integration_revision: loaded }
  writeFileSync(marker, JSON.stringify(ready))
  expect(openclawGatewayReady(env)).toBe(true)
  // An install or update rewrites the plugin; the running Gateway still
  // serves the generation it loaded until it applies the new one.
  const installed = install('/opt/notifai-next/bin/notifai')
  expect(installed).not.toBe(loaded)
  expect(openclawGatewayReady(env)).toBe(false)
  // A readiness record from a build that never named its generation is stale.
  writeFileSync(marker, JSON.stringify({ ...ready, integration_revision: undefined }))
  expect(openclawGatewayReady(env)).toBe(false)
  // The applied replacement writes readiness for the installed generation.
  writeFileSync(marker, JSON.stringify({ ...ready, integration_revision: installed }))
  expect(openclawGatewayReady(env)).toBe(true)
})
