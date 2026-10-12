import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { currentRuntimeBuild, launchSelf } from './launch-self.js'
import { HISTORICAL_LOCAL_CONTINUITY, LOCAL_CONTINUITY } from './local-continuity.js'

const roots: string[] = [], originalExecutable = process.execPath
afterEach(() => {
  Object.defineProperty(process, 'execPath', { value: originalExecutable })
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each([undefined, HISTORICAL_LOCAL_CONTINUITY, 'unknown', LOCAL_CONTINUITY])(
  'admits managed descendants only under this compiled contract: %s', contract => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-launch-contract-')); roots.push(home)
    const root = path.join(home, '.notifai'), build = 'a'.repeat(64)
    const target = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
    const id = '12345678-1234-1234-1234-123456789012', directory = path.join(root, 'versions', build)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = path.join(root, 'install.json')
    writeFileSync(file, JSON.stringify({ schema: 1, owner: 'notifai', id,
      ...(contract === undefined ? { target } : { runtime: { target, contract } }) }), { mode: 0o600 })
    const before = readFileSync(file), env = { HOME: home, USERPROFILE: home }
    Object.defineProperty(process, 'execPath', { value: path.join(directory, process.platform === 'win32' ? 'notifai-runtime.exe' : 'notifai-runtime') })
    vi.stubGlobal('NOTIFAI_COMPILED_BUILD', { sourceDirty: false, target })
    if (contract === LOCAL_CONTINUITY) expect(currentRuntimeBuild(env)).toEqual({ installation_id: id, build })
    else {
      expect(() => currentRuntimeBuild(env)).toThrow(/does not belong/)
      const retain = vi.fn()
      expect(() => launchSelf(['attendant-resume', 'fixture'], { cwd: home, env, retain })).toThrow(/does not belong/)
      expect(retain).not.toHaveBeenCalled()
    }
    expect(readFileSync(file)).toEqual(before)
  })
