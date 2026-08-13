import { describe, expect, it } from 'vitest'
import { defaultDocument, groupChanges, sectionFor, upsertChangelog } from './changelog.mjs'

describe('changelog', () => {
  it('maps commit types onto Keep a Changelog sections', () => {
    expect(sectionFor({ type: 'feat', breaking: false, description: 'add logs' })).toBe('Added')
    expect(sectionFor({ type: 'fix', breaking: false, description: 'retry on 503' })).toBe('Fixed')
    expect(sectionFor({ type: 'fix', breaking: false, description: 'fix a security hole' })).toBe('Security')
    expect(sectionFor({ type: 'feat', breaking: true, description: 'remove the presence gate' })).toBe('Removed')
    expect(sectionFor({ type: 'feat', breaking: true, description: 'require a work commitment' })).toBe('Changed')
    expect(sectionFor({ type: 'chore', breaking: false, description: 'bump ci' })).toBeNull()
  })

  it('inserts a version above history and clears Unreleased', () => {
    const seed = `${defaultDocument()}
### Added
- handwritten note

## [0.5.1] - 2026-08-13

### Fixed
- republish the stale tarball

[unreleased]: https://example/compare/v0.5.1...HEAD
[0.5.1]: https://example/releases/tag/v0.5.1
`
    const next = upsertChangelog(seed, {
      version: '0.5.2',
      date: '2026-08-14',
      groups: groupChanges([{ type: 'feat', breaking: false, description: 'wake Codex through a writer lock' }]),
      compareUrl: (from, to) => `https://example/compare/${from ?? 'start'}...${to}`,
      unreleasedUrl: (to) => `https://example/compare/${to}...HEAD`,
    })
    expect(next).toContain('## [Unreleased]\n\n## [0.5.2] - 2026-08-14')
    expect(next).toContain('- handwritten note')
    expect(next).toContain('- wake Codex through a writer lock')
    expect(next).toContain('## [0.5.1] - 2026-08-13')
    expect(next).toContain('[unreleased]: https://example/compare/0.5.2...HEAD')
    expect(next).toContain('[0.5.2]: https://example/compare/0.5.1...0.5.2')
  })
})
