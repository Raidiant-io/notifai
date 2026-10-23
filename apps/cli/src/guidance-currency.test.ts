import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { currentCommandGuidance } from './command-guidance.js'
import { guidanceShowCommand } from './commands-guidance.js'
import type { CommandDeps } from './commands-core.js'
import { rootGuidanceDigest } from './session-activation.js'
import { personalProjectGuidanceDir } from './guidance.js'
import {
  GUIDANCE_NOT_GIVEN,
  claimGuidanceChange,
  guidanceDigest,
  guidanceGiven,
  pruneGuidanceRecords,
  recordGuidanceGiven,
  shippedSkill,
  guidanceRead,
  conversationToken,
  installedSkill,
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

describe('Notification Request currency admission', () => {
  it('blocks before side effects until guidance is read, including a writing-topic or installed-copy change', async () => {
    const { cwd, env } = setup()
    env.CODEX_THREAD_ID = 'currency-session'
    const deps = { cwd, env, io: { out: () => undefined, err: () => undefined } } as unknown as CommandDeps
    recordGuidanceGiven('currency-session', env, rootGuidanceDigest(cwd, env))
    expect(guidanceRead('currency-session', env)).toBeUndefined()
    expect(currentCommandGuidance(deps)?.code).toBe('guidance_required')
    await guidanceShowCommand(deps, {})
    expect(currentCommandGuidance(deps)).toBeNull()
    const copy = path.join(env.HOME!, '.agents/skills/notifai')
    mkdirSync(copy, { recursive: true })
    writeFileSync(path.join(copy, 'SKILL.md'), 'Installed guidance v2')
    expect(installedSkill(cwd, env).file).toBe(path.join(copy, 'SKILL.md'))
    expect(currentCommandGuidance(deps)?.code).toBe('guidance_required')
    await guidanceShowCommand(deps, {})
    expect(currentCommandGuidance(deps)).toBeNull()
    const topics = personalProjectGuidanceDir(cwd, env)
    mkdirSync(topics, { recursive: true })
    writeFileSync(path.join(topics, 'titles.md'), '# Titles\n\nA writing-only change.')
    expect(currentCommandGuidance(deps)?.guidance).toContain('A writing-only change')
    await guidanceShowCommand(deps, {})
    expect(currentCommandGuidance(deps)).toBeNull()
  })

  it('returns no repeated notice if its receipt cannot be written', () => {
    const { env, root } = setup()
    const blocker = path.join(root, 'not-a-directory')
    writeFileSync(blocker, 'blocked')
    env.XDG_STATE_HOME = blocker
    expect(recordGuidanceGiven('s', env, 'd1')).toBe(false)
    expect(claimGuidanceChange('s', env, 'd2', true)).toBeUndefined()
    expect(claimGuidanceChange('s', env, 'd2', true)).toBeUndefined()
  })
})


it('never lets a Claude child read advance its root receipt when their environment id is shared', async () => {
  const { cwd, env } = setup()
  env.CLAUDECODE = '1'
  env.CLAUDE_CODE_SESSION_ID = 'shared-parent'
  env.CLAUDE_CONFIG_DIR = path.join(env.HOME!, '.claude')
  const deps = { cwd, env, io: { out: () => undefined, err: () => undefined } } as unknown as CommandDeps
  await guidanceShowCommand(deps, {})
  const original = guidanceRead('shared-parent', env)
  expect(original).toBeDefined()
  const children = path.join(env.HOME!, '.claude/projects/project/shared-parent/subagents')
  mkdirSync(children, { recursive: true })
  writeFileSync(path.join(children, 'agent-worker.jsonl'), '')
  const topics = personalProjectGuidanceDir(cwd, env)
  mkdirSync(topics, { recursive: true })
  writeFileSync(path.join(topics, 'titles.md'), '# Titles\n\nUpdated while a child is active.')
  await guidanceShowCommand(deps, {})
  expect(guidanceRead('shared-parent', env)).toBe(original)
  expect(currentCommandGuidance(deps)?.code).toBe('guidance_required')
  const childToken = conversationToken(env)!
  await guidanceShowCommand(deps, { sessionToken: childToken })
  expect(currentCommandGuidance(deps, childToken)).toBeNull()
  expect(currentCommandGuidance(deps)?.code).toBe('guidance_required')
  expect(guidanceRead('shared-parent', env)).toBe(original)
})
