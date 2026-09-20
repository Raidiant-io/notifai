import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentUpdateNotice } from './agent-update-notice.js'
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
