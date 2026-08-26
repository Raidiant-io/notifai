import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const publicReadme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
const cliReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

describe('public onboarding docs', () => {
  it('installs the CLI before the first quick-start invocation', () => {
    const using = publicReadme.slice(publicReadme.indexOf('## Using it'))
    const install = using.indexOf('npm install -g @raidiant/notifai')
    const firstInvocation = using.search(/^notifai(?:\s|$)/m)

    expect(install).toBeGreaterThan(0)
    expect(firstInvocation).toBeGreaterThan(install)
    expect(using.slice(install, firstInvocation)).toContain('@raidiant/notifai')
  })

  it('states the active Android external-test boundary without promising a public release', () => {
    const harnesses = cliReadme.slice(cliReadme.indexOf('## Agent harnesses'))

    expect(harnesses).toMatch(/Android Companion App is active[\s\S]*external testing/i)
    expect(harnesses).toMatch(/Firebase App Distribution/i)
    expect(harnesses).toMatch(/not a\s+public release or a Google Play promise/i)
  })
})
