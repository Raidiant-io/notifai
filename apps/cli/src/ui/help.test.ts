import { describe, expect, it } from 'vitest'
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
})
