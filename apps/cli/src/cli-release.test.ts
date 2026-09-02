import { afterEach, describe, expect, it } from 'vitest'
import {
  latestPublishedCliVersion,
  newerPublishedCli,
  resetLatestPublishedCliVersionForTest,
  shouldConsultCliRegistry,
} from './cli-release.js'
import { compareVersions } from './version.js'

afterEach(() => {
  resetLatestPublishedCliVersionForTest()
})

describe('CLI registry recommendation', () => {
  it('is suppressed for JSON, non-interactive, and CI callers', () => {
    expect(shouldConsultCliRegistry({ interactive: true })).toBe(true)
    expect(shouldConsultCliRegistry({ interactive: true, json: true })).toBe(false)
    expect(shouldConsultCliRegistry({ interactive: false })).toBe(false)
    expect(shouldConsultCliRegistry({ interactive: true, env: { CI: 'true' } })).toBe(false)
  })

  it('never throws when the registry is unreachable', async () => {
    const latest = await latestPublishedCliVersion(async () => {
      throw new Error('network down')
    })
    expect(latest).toBeNull()
  })

  it('caches a successful dist-tag read', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ latest: '9.1.0' }), { status: 200 })
    }
    expect(await latestPublishedCliVersion(fetchImpl)).toBe('9.1.0')
    expect(await latestPublishedCliVersion(fetchImpl)).toBe('9.1.0')
    expect(calls).toBe(1)
  })

  it('only recommends a strictly newer published version', () => {
    expect(newerPublishedCli('8.0.0', '8.0.1')).toBe('8.0.1')
    expect(newerPublishedCli('8.0.0', '8.0.0')).toBeNull()
    expect(newerPublishedCli('8.0.1', '8.0.0')).toBeNull()
    expect(compareVersions('8.0.0', '7.0.2')).toBe('after')
  })
})
