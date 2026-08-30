import { describe, expect, it } from 'vitest'
import {
  companionPlatformLabel,
  setupAccessUrl,
  setupCompanionUrl,
  supportPageUrl,
} from './setup-destinations.js'

describe('focused setup destinations', () => {
  it('sends a hosted reader to the dashboard they can sign in to', () => {
    expect(setupAccessUrl('https://api.notifai.sh')).toBe('https://app.notifai.sh/setup/access')
    expect(setupCompanionUrl('https://api.notifai.sh')).toBe(
      'https://app.notifai.sh/setup/companion',
    )
  })

  it('keeps a self-host on its own origin', () => {
    expect(setupAccessUrl('https://notify.example.com/')).toBe(
      'https://notify.example.com/setup/access',
    )
  })

  it('carries the platform this terminal already asked about', () => {
    expect(setupCompanionUrl('https://api.notifai.sh', 'iphone')).toBe(
      'https://app.notifai.sh/setup/companion?platform=iphone',
    )
    expect(setupAccessUrl('https://api.notifai.sh', 'android')).toBe(
      'https://app.notifai.sh/setup/access?platform=android',
    )
  })

  it('keeps the omnibus help page separate from any setup errand', () => {
    expect(supportPageUrl('https://api.notifai.sh')).toBe('https://app.notifai.sh/support')
    expect(setupAccessUrl('https://api.notifai.sh')).not.toContain('/support')
  })

  it('names each platform the way a reader would', () => {
    expect(companionPlatformLabel('iphone')).toBe('iPhone')
    expect(companionPlatformLabel('android')).toBe('Android')
  })
})
