import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HARNESS_UPDATE_EFFECTS, installedChangelog, releaseNotesUrl, updateSessionEffects } from './update-handoff.js'
import { SOURCE_CONTEXT_HARNESSES } from './harnesses.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('includes only the installed releases newer than the previous installation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-changelog-'))
  roots.push(root)
  writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changes\n## [3.0.0]\nFuture\n## [2.1.0]\nNew guidance\n## [2.0.0]\nQueue support\n## [1.0.0]\nOld\n')
  const result = installedChangelog('2.1.0', '1.0.0', root)
  expect(result.text).toContain('New guidance')
  expect(result.text).toContain('Queue support')
  expect(result.text).not.toContain('Future')
  expect(result.text).not.toContain('Old')
  expect(result.complete).toBe(true)
  expect(installedChangelog('2.1.0', '2.1.0', root).text).toBe('')
})

it.each(SOURCE_CONTEXT_HARNESSES)('does not require a restart for a ready %s installation', harness => {
  expect(HARNESS_UPDATE_EFFECTS[harness]).toBeTruthy()
  expect(updateSessionEffects(harness, [{ id: 'hooks', title: 'Hooks', status: 'ready', detail: 'current' }])).toMatchObject({ restart_required: false, assessment: 'continue' })
})

it('separates a proven stale Codex runtime from repair gaps and unknown ownership', () => {
  const gap = { id: 'hooks-trust', title: 'Trust', status: 'gap' as const, detail: 'approval missing' }
  expect(updateSessionEffects('codex', [gap])).toMatchObject({ restart_required: null, assessment: 'needs_attention' })
  expect(updateSessionEffects('codex', [gap], 'loaded Stop fingerprint differs')).toMatchObject({ restart_required: true, assessment: 'fresh_session' })
  expect(updateSessionEffects(null, [])).toMatchObject({ restart_required: null, assessment: 'unknown' })
  expect(updateSessionEffects('codex', [])).toMatchObject({ restart_required: null, assessment: 'unknown' })
})

it('constructs release links only from valid artifact versions', () => {
  expect(releaseNotesUrl('11.1.1')).toBe('https://github.com/Raidiant-io/notifai/releases/tag/v11.1.1')
  expect(releaseNotesUrl('11.1.1/../../other')).toBeNull()
})
