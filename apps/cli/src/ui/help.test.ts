import { describe, expect, it } from 'vitest'
import { shippedGuidanceTopic } from '../guidance-content.js'
import { rootHelpFooter } from './help.js'

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, '')
}

describe('rootHelpFooter', () => {
  it('leads first-run with init, not the interactive app', () => {
    const footer = stripAnsi(rootHelpFooter())
    const start = footer.slice(footer.indexOf('Start here'))
    const firstCommand = start.match(/notifai(?: init)?/)?.[0]
    expect(firstCommand).toBe('notifai init')
    expect(start.indexOf('notifai init')).toBeLessThan(start.search(/notifai\s{2,}/))
  })

  it('gives agents first calls that run as written and follow the titles guidance', () => {
    const footer = stripAnsi(rootHelpFooter())
    const send = footer.match(/^\s*(notifai send .*)$/m)?.[1] ?? ''
    const ask = footer.match(/^\s*(notifai ask .*)$/m)?.[1] ?? ''
    for (const flag of ['--kind done', '--title "', '--summary "']) expect(send, flag).toContain(flag)
    expect(ask).toContain('--title "')
    const titles = shippedGuidanceTopic('titles')!.content
    const bad = [...titles.slice(titles.indexOf('Bad:')).matchAll(/`([^`]+)`/g)].map((match) => match[1]!)
    expect(bad).toContain('All 42 tests passed')
    for (const title of bad) expect(footer, title).not.toContain(`"${title}"`)
  })
})
