import { afterEach,describe,expect,it } from 'vitest'
import {
publishedCliDistTags,
resetPublishedCliDistTagsForTest,
shouldConsultCliRegistry
} from './cli-release.js'

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
})
