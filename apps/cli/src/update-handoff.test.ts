import { mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,expect,it } from 'vitest'
import { SOURCE_CONTEXT_HARNESSES } from './harnesses.js'
import { HARNESS_UPDATE_EFFECTS,installedChangelog,updateSessionEffects } from './update-handoff.js'

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

it.each(SOURCE_CONTEXT_HARNESSES.filter(harness => harness !== 'codex'))('does not require a restart for a ready %s installation', harness => {
  expect(HARNESS_UPDATE_EFFECTS[harness]).toBeTruthy()
  expect(updateSessionEffects(harness, [{ id: 'hooks', title: 'Hooks', status: 'ready', detail: 'current' }])).toMatchObject({ restart_required: false, assessment: 'continue' })
})
