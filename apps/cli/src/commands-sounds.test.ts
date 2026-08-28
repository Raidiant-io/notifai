import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from './client.js'
import { EXIT, type CommandDeps, type CommandIo } from './commands-core.js'
import { soundsCommand } from './commands-sounds.js'

class CapturedIo implements CommandIo {
  readonly outLines: string[] = []
  readonly errLines: string[] = []
  out(line: string): void {
    this.outLines.push(line)
  }
  err(line: string): void {
    this.errLines.push(line)
  }
  async confirm(): Promise<boolean> {
    return true
  }
  openUrl(): void {}
}

function makeDeps(io: CapturedIo, client: ApiClient): CommandDeps {
  const testRoot = path.join(os.tmpdir(), 'notifai-cli-sounds-tests')
  return {
    io,
    store: {
      load: () => ({
        machineId: 'mac_test',
        secret: 'test-secret',
        baseUrl: 'https://test.notifai.invalid',
        machineName: 'test-machine',
      }),
      save: () => {},
      clear: () => {},
      describe: () => 'test credential store',
    },
    env: {
      XDG_CONFIG_HOME: testRoot,
      XDG_STATE_HOME: path.join(os.tmpdir(), 'notifai-cli-sounds-tests-state'),
    },
    cwd: os.tmpdir(),
    clientFactory: () => client,
  }
}

const kitchenTimer = {
  sound_id: 'snd_kitchen',
  name: 'Kitchen timer',
  duration_ms: 2400,
  content_hash: 'a'.repeat(64),
  url: 'https://wav.example/kitchen.wav',
}

describe('soundsCommand', () => {
  it('lists shipped names and Account custom sounds', async () => {
    const io = new CapturedIo()
    const client = {
      listSounds: async () => ({ sounds: [kitchenTimer] }),
    } as unknown as ApiClient

    expect(await soundsCommand(makeDeps(io, client), {})).toBe(EXIT.ok)
    expect(io.outLines[0]).toBe('default  Device default')
    expect(io.outLines).toContain('done  completion chime')
    expect(io.outLines).toContain('none  silent')
    expect(io.outLines.at(-1)).toBe('snd_kitchen  Kitchen timer  2.4s')
  })

  it('prints the catalog as JSON when asked', async () => {
    const io = new CapturedIo()
    const client = {
      listSounds: async () => ({ sounds: [kitchenTimer] }),
    } as unknown as ApiClient

    expect(await soundsCommand(makeDeps(io, client), { json: true })).toBe(EXIT.ok)
    const parsed = JSON.parse(io.outLines.join('\n')) as {
      shipped: { ref: string; name: string }[]
      custom: typeof kitchenTimer[]
    }
    expect(parsed.shipped[0]).toEqual({ ref: 'default', name: 'Device default' })
    expect(parsed.custom).toEqual([kitchenTimer])
  })

  it('refuses to list custom sounds when this machine is not signed in', async () => {
    const io = new CapturedIo()
    let calls = 0
    const deps: CommandDeps = {
      ...makeDeps(io, {
        listSounds: async () => {
          calls += 1
          return { sounds: [] }
        },
      } as unknown as ApiClient),
      store: {
        load: () => null,
        save: () => {},
        clear: () => {},
        describe: () => 'empty store',
      },
    }

    expect(await soundsCommand(deps, {})).toBe(EXIT.auth)
    expect(calls).toBe(0)
    expect(io.errLines.join('\n')).toMatch(/not signed in/i)
  })
})
