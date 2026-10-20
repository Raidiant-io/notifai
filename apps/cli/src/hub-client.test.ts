import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hubEnvironment, hubNetworkPath, readHubNetwork, recordHubNetwork } from './hub-client.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function stateEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join('/tmp', 'nfnet-'))
  roots.push(root)
  return { HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'), PATH: '/usr/bin:/bin', ...extra }
}

describe('the hub environment', () => {
  it('keeps the account and Notifai settings, and drops session variables and secrets the starter had', () => {
    const env = stateEnv({ LANG: 'C.UTF-8', LC_ALL: 'C', NOTIFAI_API_URL: 'https://example.invalid', OPENAI_API_KEY: 'sk-dummy',
      GITHUB_TOKEN: 'ghp_dummy', CLAUDE_CODE_SESSION_ID: 'abc', NOTIFAI_HOOK_SOURCE_PID: '42', DISPLAY: ':1', CODEX_HOME: '/x/codex' })
    expect(Object.keys(hubEnvironment(env)).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'NOTIFAI_API_URL', 'PATH', 'XDG_STATE_HOME'])
  })

  it('reaches the service as the User\'s sign-in did, not as whichever process started it', () => {
    const signIn = stateEnv({ HTTPS_PROXY: 'http://proxy.example:3128', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' })
    expect(recordHubNetwork(signIn)).toBe(true)
    expect(statSync(hubNetworkPath(signIn)).mode & 0o777).toBe(0o600)
    expect(recordHubNetwork(signIn)).toBe(false)
    // A session started from a shell without the proxy, or with another one, starts the hub.
    const starter = { ...signIn, HTTPS_PROXY: 'http://other.example:8080' }
    delete starter['NO_PROXY']
    delete starter['NODE_EXTRA_CA_CERTS']
    expect(hubEnvironment(starter)).toMatchObject({ HTTPS_PROXY: 'http://proxy.example:3128', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' })
    // Signing in without a proxy records a direct connection.
    const direct = { ...signIn }
    for (const name of ['HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) delete direct[name]
    expect(recordHubNetwork(direct)).toBe(true)
    expect(readHubNetwork(direct)).toEqual({})
    expect(hubEnvironment(starter)['HTTPS_PROXY']).toBeUndefined()
  })

  it('records the first starter\'s settings once on a machine signed in before there was a record', () => {
    const first = stateEnv({ HTTPS_PROXY: 'http://proxy.example:3128', OPENAI_API_KEY: 'sk-dummy' })
    expect(existsSync(hubNetworkPath(first))).toBe(false)
    expect(hubEnvironment(first)['HTTPS_PROXY']).toBe('http://proxy.example:3128')
    expect(statSync(hubNetworkPath(first)).mode & 0o777).toBe(0o600)
    expect(readHubNetwork(first)).toEqual({ HTTPS_PROXY: 'http://proxy.example:3128' })
    // A later starter with other settings changes nothing: only sign-in does.
    const later = { ...first, HTTPS_PROXY: 'http://other.example:8080' }
    expect(hubEnvironment(later)['HTTPS_PROXY']).toBe('http://proxy.example:3128')
  })
})
