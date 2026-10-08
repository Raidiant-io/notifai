import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODEX_SHARED_SERVER_STATE_ID, codexSharedServerState, type CodexDaemonVersion } from './codex-shared-server-health.js'

function home(name = 'h'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nf-css-'))
  const codex = path.join(root, name)
  mkdirSync(codex, { recursive: true })
  return codex
}

const running = (server: string, cli: string): CodexDaemonVersion =>
  ({ status: 'running', managedCodexVersion: server, appServerVersion: server, cliVersion: cli })

describe('codexSharedServerState', () => {
  it('says nothing when Codex cannot be asked', async () => {
    expect(await codexSharedServerState({ CODEX_HOME: home() }, 'darwin', async () => null)).toBeNull()
  })

  it('reports a missing server as a legitimate choice and names daemon_auto_start when set', async () => {
    const codex = home()
    writeFileSync(path.join(codex, 'config.toml'), '[features]\ndaemon_auto_start = false # set elsewhere\n')
    const state = await codexSharedServerState({ CODEX_HOME: codex }, 'darwin', async () => 'not-running')
    expect(state).toMatchObject({ id: CODEX_SHARED_SERVER_STATE_ID, status: 'optional-gap' })
    expect(state!.detail).toContain('`daemon_auto_start = false`')
    expect(state!.detail).toContain("until the agent's turn ends")
    expect(state!.remedy).toBeUndefined()
  })

  it('does not blame configuration it did not find', async () => {
    const state = await codexSharedServerState({ CODEX_HOME: home() }, 'darwin', async () => 'not-running')
    expect(state!.detail).toContain('--no-daemon')
    expect(state!.detail).not.toContain('daemon_auto_start')
  })

  it('is ready when the running server matches the CLI', async () => {
    const state = await codexSharedServerState({ CODEX_HOME: home() }, 'darwin', async () => running('0.161.0', '0.161.0'))
    expect(state).toMatchObject({ status: 'ready' })
    expect(state!.detail).toContain('0.161.0')
  })

  it('flags version drift and keeps production updates where the updater can run', async () => {
    // The drift branch only measures the path, so a short literal home is safe.
    const state = await codexSharedServerState({ CODEX_HOME: '/c' }, 'darwin', async () => running('0.157.0', '0.161.0'))
    expect(state).toMatchObject({ status: 'optional-gap', technical: { app_server_version: '0.157.0', cli_version: '0.161.0', updater_socket_path_too_long: false } })
    expect(state!.remedy).toMatchObject({ by: 'user-here', command: 'codex app-server daemon update --yes' })
  })

  it('pins the CLI package where the updater socket path cannot bind', async () => {
    const deep = home(path.join('Library', 'Application Support', 'orca', 'codex-accounts', '00000000-0000-0000-0000-000000000000', 'home'))
    const state = await codexSharedServerState({ CODEX_HOME: deep }, 'darwin', async () => running('0.157.0', '0.161.0'))
    expect(state!.detail).toContain('will not catch up on its own')
    expect(state!.remedy).toMatchObject({ command: 'codex app-server daemon update --from-cli --yes' })
  })
})
