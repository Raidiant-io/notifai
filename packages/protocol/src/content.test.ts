import { describe, expect, it } from 'vitest'
import {
  BANNER_EXCERPT_EMPTY_FALLBACK,
  BANNER_EXCERPT_MAX_LENGTH,
  bannerExcerpt,
} from './content.js'

describe('bannerExcerpt', () => {
  it.each([
    ['short plain text', 'All checks passed.', 'All checks passed.'],
    ['line endings', '# Result\r\n\rNext step', 'Result\nNext step'],
    ['headings and emphasis', '## **Build** _finished_\n~~Old~~ new', 'Build finished\nOld new'],
    ['links and inline code', '[release](https://example.test) used `v2`', 'release used v2'],
    ['autolinks', '<https://example.test/run/42>', 'https://example.test/run/42'],
    ['image alt', '![comparison](media:med_one)', 'comparison'],
    ['empty image alt', 'before ![](media:med_one) after', 'before after'],
    ['tables', '| Name | Result |\n| --- | --- |\n| API | pass |\nSummary', 'Summary'],
    ['fenced code', 'Before\n```ts\nconst hidden = true\n```\nAfter', 'Before\nAfter'],
    ['tilde fence', 'Before\n~~~~\nhidden\n~~~~\nAfter', 'Before\nAfter'],
    ['unterminated fence', 'Before\n```\nhidden forever', 'Before'],
    ['nested block markers', '> > - [x] **Shipped**', 'Shipped'],
    ['ordered lists', '1. First\n2) Second', 'First\nSecond'],
    ['thematic breaks', 'Before\n - - - \n***\n___\nAfter', 'Before\nAfter'],
    ['CJK', '# 完了\nすべての確認が通りました。', '完了\nすべての確認が通りました。'],
  ])('%s', (_name, markdown, expected) => {
    expect(bannerExcerpt(markdown)).toBe(expected)
  })

  it('keeps exactly 300 characters without an ellipsis', () => {
    const body = 'x'.repeat(BANNER_EXCERPT_MAX_LENGTH)
    expect(bannerExcerpt(body)).toBe(body)
  })

  it('truncates at the last whitespace within the bound', () => {
    const body = `${'word '.repeat(60)}tail beyond the bound`
    const excerpt = bannerExcerpt(body)
    expect(excerpt).toBe(`${'word '.repeat(60).trimEnd()}…`)
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(BANNER_EXCERPT_MAX_LENGTH + 1)
  })

  it('hard-cuts text with no whitespace', () => {
    const excerpt = bannerExcerpt('界'.repeat(BANNER_EXCERPT_MAX_LENGTH + 20))
    expect(excerpt).toBe(`${'界'.repeat(BANNER_EXCERPT_MAX_LENGTH)}…`)
  })

  it('uses the frozen fallback when no readable text survives', () => {
    expect(bannerExcerpt('```\nconst x = 1\n```\n![](media:med_one)')).toBe(
      BANNER_EXCERPT_EMPTY_FALLBACK,
    )
  })
})
