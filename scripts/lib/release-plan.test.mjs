import { describe, expect, it } from 'vitest'
import { packagesFor } from './packages.mjs'
import { planRelease } from './release-plan.mjs'

describe('packagesFor', () => {
  it('trusts an explicit scope and still infers from paths', () => {
    expect([...packagesFor({ scope: 'cli', files: [] })]).toEqual(['cli'])
    expect([...packagesFor({ scope: 'skill', files: [] })]).toEqual(['cli'])
    expect([...packagesFor({ scope: 'repo', files: ['scripts/release.mjs'] })]).toEqual([])
    expect([...packagesFor({ scope: null, files: ['apps/cli/src/main.ts'] })]).toEqual(['cli'])
    expect([...packagesFor({ scope: null, files: ['packages/protocol/src/index.ts'] })]).toEqual(['protocol'])
    expect([...packagesFor({ scope: 'cli', files: ['packages/protocol/src/index.ts'] })].sort()).toEqual([
      'cli',
      'protocol',
    ])
  })
})

describe('planRelease', () => {
  const current = [
    { id: 'cli', version: '0.5.1' },
    { id: 'protocol', version: '0.3.0' },
  ]

  it('bumps only the packages the commits belong to', () => {
    const plan = planRelease({
      packages: current,
      baselines: { cli: 'v0.5.1', protocol: 'v0.5.1' },
      commits: [
        {
          sha: 'aaa1111',
          subject: 'feat(cli): wake Codex through a writer lock',
          body: '',
          files: ['apps/cli/src/codex-wake.ts'],
        },
        {
          sha: 'bbb2222',
          subject: 'fix(protocol): reject an empty question set',
          body: '',
          files: ['packages/protocol/src/ask.ts'],
        },
      ],
    })
    expect(plan.ok).toBe(true)
    const cli = plan.packages.find((pkg) => pkg.id === 'cli')
    const protocol = plan.packages.find((pkg) => pkg.id === 'protocol')
    expect(cli).toMatchObject({ from: '0.5.1', to: '0.5.2', bump: 'patch', tag: 'v0.5.2' })
    expect(protocol).toMatchObject({ from: '0.3.0', to: '0.3.1', bump: 'patch', tag: 'protocol-v0.3.1' })
  })

  it('ignores pre-convention prose and fails a malformed conventional attempt', () => {
    const skipped = planRelease({
      packages: current,
      baselines: { cli: 'v0.5.1', protocol: 'v0.5.1' },
      commits: [
        {
          sha: 'ccc3333deadbeef',
          subject: 'Wake Claude sessions through the inbox socket',
          body: '',
          files: ['apps/cli/src/claude-wake.ts'],
        },
      ],
    })
    expect(skipped.ok).toBe(true)
    expect(skipped.warnings.join('\n')).toMatch(/pre-convention prose/)
    expect(skipped.packages.every((pkg) => pkg.bump === null)).toBe(true)

    const bad = planRelease({
      packages: current,
      baselines: { cli: 'v0.5.1', protocol: 'v0.5.1' },
      commits: [
        {
          sha: 'eee5555deadbeef',
          subject: 'feat(cli): add a trailing period.',
          body: '',
          files: ['apps/cli/src/main.ts'],
        },
      ],
    })
    expect(bad.ok).toBe(false)
    expect(bad.errors.join('\n')).toMatch(/period/)
  })

  it('does not bump for chore-only work', () => {
    const plan = planRelease({
      packages: current,
      baselines: { cli: 'v0.5.1', protocol: 'v0.5.1' },
      commits: [
        {
          sha: 'ddd4444',
          subject: 'chore(repo): add the release machine',
          body: '',
          files: ['scripts/release.mjs'],
        },
      ],
    })
    expect(plan.ok).toBe(true)
    expect(plan.packages.every((pkg) => pkg.bump === null)).toBe(true)
  })
})
