import { describe, expect, it } from 'vitest'
import { supportPageUrl } from './commands-devices.js'

describe('supportPageUrl', () => {
  it('routes hosted control-plane origins to the dashboard support surface', () => {
    expect(supportPageUrl('https://api.notifai.sh')).toBe('https://app.notifai.sh/support')
    expect(supportPageUrl('https://notifai.fly.dev/')).toBe('https://app.notifai.sh/support')
  })

  it('keeps a self-hosted deployment on its own support route', () => {
    expect(supportPageUrl('https://notifai.example.test/')).toBe(
      'https://notifai.example.test/support',
    )
  })
})
