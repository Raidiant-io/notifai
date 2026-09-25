import { afterEach, describe, expect, it } from 'vitest'
import {
  cliReleaseTarget,
  newerPublishedCli,
  parseCliDistTags,
  publishedCliDistTags,
  resetPublishedCliDistTagsForTest,
  shouldConsultCliRegistry,
} from './cli-release.js'
import { cliUpdateChannel, cliUpdateRecoveryCommand } from './cli-contract.js'

afterEach(() => {
  resetPublishedCliDistTagsForTest()
})

describe('CLI registry recommendation', () => {
  it('allows explicit diagnostics and suppresses CI', () => {
    expect(shouldConsultCliRegistry({})).toBe(true)
    expect(shouldConsultCliRegistry({ env: { CI: 'true' } })).toBe(false)
  })

  it('never throws when the registry is unreachable', async () => {
    const tags = await publishedCliDistTags(async () => {
      throw new Error('network down')
    })
    expect(tags).toBeNull()
  })

  it('caches a successful dist-tag read', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ latest: '9.1.0', beta: '9.2.0-beta.1' }), { status: 200 })
    }
    expect(await publishedCliDistTags(fetchImpl)).toEqual({ latest: '9.1.0', beta: '9.2.0-beta.1' })
    expect(await publishedCliDistTags(fetchImpl)).toEqual({ latest: '9.1.0', beta: '9.2.0-beta.1' })
    expect(calls).toBe(1)
  })

  it('treats a malformed update tag as unreadable rather than guessing', () => {
    expect(parseCliDistTags({ latest: '9.1.0' })).toEqual({ latest: '9.1.0', beta: null })
    expect(parseCliDistTags({ latest: '9.2.0-beta.1' })).toBeNull()
    expect(parseCliDistTags({ latest: '9.1.0', beta: '9.2.0' })).toBeNull()
    expect(parseCliDistTags({ latest: '9.1.0', beta: 'next' })).toBeNull()
    expect(parseCliDistTags({ beta: '9.2.0-beta.1' })).toBeNull()
  })

  it('only recommends a strictly newer stable release to a stable installation', () => {
    expect(newerPublishedCli('8.0.0', { latest: '8.0.1', beta: null })).toBe('8.0.1')
    expect(newerPublishedCli('8.0.0', { latest: '8.0.0', beta: null })).toBeNull()
    expect(newerPublishedCli('8.0.1', { latest: '8.0.0', beta: null })).toBeNull()
    expect(newerPublishedCli('8.0.0', { latest: '8.0.0', beta: '8.1.0-beta.1' })).toBeNull()
  })

  it('tells a beta tester about a newer beta and about the stable release that supersedes it', () => {
    expect(newerPublishedCli('11.4.0-beta.1', { latest: '11.3.2', beta: '11.4.0-beta.2' })).toBe('11.4.0-beta.2')
    expect(newerPublishedCli('11.4.0-beta.2', { latest: '11.4.0', beta: '11.4.0-beta.2' })).toBe('11.4.0')
    expect(newerPublishedCli('11.4.0-beta.2', { latest: '11.3.2', beta: '11.4.0-beta.2' })).toBeNull()
    expect(newerPublishedCli('11.4.0-beta.2', { latest: '11.3.2', beta: null })).toBeNull()
    // The recommended update keeps the tester on the channel that delivers both.
    expect(cliUpdateRecoveryCommand(cliUpdateChannel('11.4.0-beta.1'))).toContain('--channel beta')
    expect(cliUpdateRecoveryCommand(cliUpdateChannel('11.3.2'))).not.toContain('--channel')
  })

  it('resolves the beta channel to the higher of beta and latest', () => {
    expect(cliReleaseTarget({ latest: '11.3.2', beta: '11.4.0-beta.1' }, 'beta'))
      .toEqual({ version: '11.4.0-beta.1', dist_tag: 'beta' })
    expect(cliReleaseTarget({ latest: '11.4.0', beta: '11.4.0-beta.1' }, 'beta'))
      .toEqual({ version: '11.4.0', dist_tag: 'latest' })
    expect(cliReleaseTarget({ latest: '11.4.0', beta: null }, 'beta'))
      .toEqual({ version: '11.4.0', dist_tag: 'latest' })
    expect(cliReleaseTarget({ latest: '11.3.2', beta: '11.4.0-beta.1' }, 'stable'))
      .toEqual({ version: '11.3.2', dist_tag: 'latest' })
  })
})
