import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const publicReadme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
const cliReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

describe('public onboarding docs', () => {
  it('installs the CLI before the first quick-start invocation', () => {
    const using = publicReadme.slice(publicReadme.indexOf('## Using it'))
    const installationLink = using.match(/\[[^\]]+\]\((skills\/notifai\/references\/installation\.md)\)/)
    const install = installationLink?.index ?? -1
    const firstInvocation = using.search(/^notifai(?:\s|$)/m)

    expect(install).toBeGreaterThan(0)
    expect(firstInvocation).toBeGreaterThan(install)
    expect(existsSync(new URL(`../../../${installationLink?.[1]}`, import.meta.url))).toBe(true)
  })

  it('states the public Android download and closed Play tester distribution', () => {
    const harnesses = cliReadme.slice(cliReadme.indexOf('## Agent harnesses'))

    expect(harnesses).toMatch(/iPhone\s+and Android Companion Apps are both active/i)
    expect(harnesses).toMatch(/directly downloadable signed APK/i)
    expect(harnesses).toMatch(/Google Play closed Alpha/i)
    expect(harnesses).not.toMatch(/Firebase App Distribution/i)
  })
})
