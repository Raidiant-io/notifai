import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { personalProjectGuidanceDir } from './guidance.js'
import {
  GUIDANCE_NOT_GIVEN,
  claimGuidanceChange,
  guidanceDigest,
  guidanceGiven,
  pruneGuidanceRecords,
  recordGuidanceGiven,
  shippedSkill,
  startingCurrency,
} from './guidance-currency.js'

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-guidance-currency-'))
  const cwd = path.join(root, 'project')
  mkdirSync(cwd)
  execFileSync('git', ['init', '-q', cwd])
  const env: NodeJS.ProcessEnv = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  return { root, cwd, env }
}

describe('guidance digest', () => {
  it('changes with the skill, a topic or the activation text, and with nothing else', () => {
    const { cwd, env } = setup()
    const skill = { digest: 'sha256:one', file: '/opt/notifai/versions/1/skill-source/notifai/SKILL.md' }
    const base = guidanceDigest({ cwd, env, activation: 'You own Notification Requests.', skill })
    // A new version directory alone is not a change of guidance.
    expect(guidanceDigest({ cwd, env, activation: 'You own Notification Requests.', skill: { ...skill, file: '/opt/notifai/versions/2/SKILL.md' } })).toBe(base)
    expect(guidanceDigest({ cwd, env, activation: 'You own Notification Requests.', skill: { ...skill, digest: 'sha256:two' } })).not.toBe(base)
    expect(guidanceDigest({ cwd, env, activation: 'You own them.', skill })).not.toBe(base)
    const dir = personalProjectGuidanceDir(cwd, env)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'titles.md'), '# Titles\n\nShort.\n')
    expect(guidanceDigest({ cwd, env, activation: 'You own Notification Requests.', skill })).not.toBe(base)
  })

  it('reads the skill this build ships', () => {
    const skill = shippedSkill()
    expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(skill.file).toMatch(/notifai[/\\]SKILL\.md$/)
  })
})

describe('what a session was given', () => {
  it('tells a session once per change, and never one started with guidance off', () => {
    const { env } = setup()
    expect(claimGuidanceChange('never-started', env, 'd1', false)).toBeUndefined()
    expect(claimGuidanceChange('earlier-build', env, 'd1', true)).toMatch(/^Notifai's guidance changed/)
    expect(claimGuidanceChange('earlier-build', env, 'd1', true)).toBeUndefined()
    expect(claimGuidanceChange('earlier-build', env, 'd2', true)).toMatch(/^Notifai's guidance changed/)
    recordGuidanceGiven('off', env, GUIDANCE_NOT_GIVEN)
    expect(claimGuidanceChange('off', env, 'd3', true)).toBeUndefined()
    expect(guidanceGiven('earlier-build', env)).toBe('d2')
  })

  it('has a starting session reload after a compaction or a change, and a resumed one Notifai never recorded', () => {
    const { env } = setup()
    expect(startingCurrency({ sessionId: 's', env, digest: 'd1', source: 'startup' })).toBeUndefined()
    expect(startingCurrency({ sessionId: 's', env, digest: 'd1', source: 'resume' })).toMatch(/^Notifai's guidance changed/)
    expect(startingCurrency({ sessionId: 's', env, digest: 'd1', source: 'compact' })).toMatch(/^This conversation was compacted\./)
    expect(startingCurrency({ sessionId: 's', env, digest: 'd1', compacted: true })).toMatch(/^This conversation was compacted\./)
    recordGuidanceGiven('s', env, 'd1')
    expect(startingCurrency({ sessionId: 's', env, digest: 'd1', source: 'resume' })).toBeUndefined()
    expect(startingCurrency({ sessionId: 's', env, digest: 'd2', source: 'resume' })).toMatch(/^Notifai's guidance changed/)
    expect(startingCurrency({ sessionId: 's', env, digest: 'd2' })).toMatch(/^Notifai's guidance changed/)
  })

  it('forgets records no session touched in a month', () => {
    const { env } = setup()
    recordGuidanceGiven('old', env, 'd1')
    recordGuidanceGiven('recent', env, 'd1')
    const name = `${createHash('sha256').update('old').digest('hex').slice(0, 40)}.json`
    const aged = new Date(Date.now() - 40 * 24 * 3600 * 1000)
    utimesSync(path.join(env.XDG_STATE_HOME!, 'notifai', 'guidance-given', name), aged, aged)
    expect(pruneGuidanceRecords(env)).toBe(1)
    expect(guidanceGiven('old', env)).toBeUndefined()
    expect(guidanceGiven('recent', env)).toBe('d1')
  })
})
