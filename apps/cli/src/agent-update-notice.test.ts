import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentUpdateNotice, cachedAgentUpdateNotice, pendingAgentUpdateNotice, refreshAgentUpdateState } from './agent-update-notice.js'
import { stateDir } from './config.js'
import { packageVersion } from './release.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(latest = '99.0.0') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-weekly-'))
  roots.push(root)
  const env = { XDG_STATE_HOME: root }
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ latest })))
  const check = (now = NOW) => agentUpdateNotice({ env, now, updateCommand: 'notifai update', fetchImpl })
  return { env, fetchImpl, check }
}

describe('automatic update notice', () => {
  it('offers work once a week even across a process restart or a newer release', async () => {
    const f = fixture()
    expect(await f.check()).toContain('offer to perform the update')
    f.fetchImpl.mockImplementation(async () => new Response('{"latest":"99.1.0"}'))
    expect(await f.check(NOW + 1)).toBeUndefined()
    expect(await f.check(NOW - DAY)).toBeUndefined()
    expect(await f.check(NOW + 7 * DAY - 1)).toBeUndefined()
    expect(await f.check(NOW + 7 * DAY)).toContain('A newer Notifai is available.')
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([packageVersion()!, '0.0.1', 'not a version'])('stays quiet for %s and bounds repeated lookups', async latest => {
    const f = fixture(latest)
    expect(await f.check()).toBeUndefined()
    expect(await f.check(NOW + 1)).toBeUndefined()
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    expect(await f.check(NOW + DAY)).toBeUndefined()
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not turn registry or state failures into agent errors or repeated requests', async () => {
    const f = fixture()
    f.fetchImpl.mockRejectedValue(new Error('offline'))
    expect(await f.check()).toBeUndefined()
    expect(await f.check(NOW + 1)).toBeUndefined()
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    const file = path.join(stateDir(f.env), 'cli-update-notice.json')
    writeFileSync(file, '{broken')
    expect(await f.check(NOW + DAY)).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })

  it('does not create state or consult the registry in CI', async () => {
    const f = fixture()
    expect(await agentUpdateNotice({ env: { ...f.env, CI: 'true' }, now: NOW, updateCommand: 'unused', fetchImpl: f.fetchImpl })).toBeUndefined()
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('lets only one independent process emit the machine-wide notice', async () => {
    const f = fixture()
    const module = new URL('../dist/agent-update-notice.js', import.meta.url).href
    const code = `import { agentUpdateNotice } from ${JSON.stringify(module)};
      const notice = await agentUpdateNotice({env:${JSON.stringify(f.env)},now:${NOW},updateCommand:'notifai update',
        fetchImpl:async()=>{await new Promise(r=>setTimeout(r,50));return new Response('{"latest":"99.0.0"}')}});
      process.stdout.write(JSON.stringify(notice ?? null));`
    const runs = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code])))
    expect(runs.map(run => JSON.parse(run.stdout)).filter(Boolean)).toHaveLength(1)
  })
})

describe('update notice on the prompt path', () => {
  it('reads only what the off-path lookup recorded and never consults the registry itself', async () => {
    const f = fixture()
    const read = (now = NOW, currentVersion?: string) =>
      cachedAgentUpdateNotice({ env: f.env, now, updateCommand: 'notifai update', ...(currentVersion === undefined ? {} : { currentVersion }) })
    expect(read()).toBeUndefined()
    expect(f.fetchImpl).not.toHaveBeenCalled()

    await refreshAgentUpdateState({ env: f.env, now: NOW, fetchImpl: f.fetchImpl })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    // A User who already moved to that release is offered nothing.
    expect(read(NOW, '99.0.0')).toBeUndefined()
    expect(read(NOW)).toContain('A newer Notifai is available.')
    expect(read(NOW + 1)).toBeUndefined()
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('stays due until a reader claims it, and is claimed once', async () => {
    const f = fixture()
    await refreshAgentUpdateState({ env: f.env, now: NOW, fetchImpl: f.fetchImpl })
    const read = () => pendingAgentUpdateNotice({ env: f.env, now: NOW, updateCommand: 'notifai update' })
    const unshown = read()
    expect(unshown?.text).toContain('A newer Notifai is available.')
    // Reading spends nothing: a context without room for it leaves it due.
    const shown = read()
    expect(shown?.text).toBe(unshown?.text)
    expect(shown!.claim()).toBe(true)
    // Another reader that saw it before the claim cannot show it again.
    expect(unshown!.claim()).toBe(false)
    expect(read()).toBeUndefined()
  })

  it('keeps a known release when a later lookup cannot reach the registry', async () => {
    const f = fixture()
    await refreshAgentUpdateState({ env: f.env, now: NOW, fetchImpl: f.fetchImpl })
    f.fetchImpl.mockRejectedValue(new Error('offline'))
    await refreshAgentUpdateState({ env: f.env, now: NOW + DAY, fetchImpl: f.fetchImpl })
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    expect(cachedAgentUpdateNotice({ env: f.env, now: NOW + DAY, updateCommand: 'notifai update' })).toContain('notifai update')
  })
})

describe('update notice with automatic updates', () => {
  it('makes the weekly offer only when automatic updates are off on a machine that has an updater', async () => {
    const f = fixture()
    const env = { ...f.env, XDG_CONFIG_HOME: path.join(f.env.XDG_STATE_HOME, 'config') }
    await refreshAgentUpdateState({ env, now: NOW, fetchImpl: f.fetchImpl })
    const read = (now: number, automaticRunsHere = true) =>
      cachedAgentUpdateNotice({ env, now, updateCommand: 'notifai update', automaticRunsHere })
    expect(read(NOW)).toBeUndefined()
    expect(read(NOW + 30 * DAY)).toBeUndefined()
    mkdirSync(path.join(env.XDG_CONFIG_HOME, 'notifai'), { recursive: true })
    writeFileSync(path.join(env.XDG_CONFIG_HOME, 'notifai', 'config.toml'), '"updates.automatic" = false\n')
    expect(read(NOW + 30 * DAY)).toContain('offer to perform the update')
    // A machine without an updater (Windows today, development builds) keeps offering with the setting on.
    writeFileSync(path.join(env.XDG_CONFIG_HOME, 'notifai', 'config.toml'), '"updates.automatic" = true\n')
    expect(read(NOW + 40 * DAY, false)).toContain('offer to perform the update')
  })
})
