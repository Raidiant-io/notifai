import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const skill = readFileSync(new URL('../../../skills/notifai/SKILL.md', import.meta.url), 'utf8')
const harnessReference = readFileSync(
  new URL('../../../skills/notifai/references/harness-setup.md', import.meta.url),
  'utf8',
)

describe('Notifai agent skill', () => {
  it('leads with the notification decision before message composition', () => {
    expect(skill.indexOf('## When to notify')).toBeGreaterThan(0)
    expect(skill.indexOf('## When to notify')).toBeLessThan(skill.indexOf('## Compose and send'))
  })

  it('separates semantic kind from native-banner attention', () => {
    expect(skill).toContain('--kind done')
    expect(skill).toMatch(/Kind never chooses a native-banner sound\s+or\s+interruption level/)
    expect(skill).toContain('lets the destination use its normal behavior')
    expect(skill).not.toContain('Kind profiles')
    expect(skill).not.toMatch(/\| `failed` \| `alert`/)
    expect(skill).not.toMatch(/\| `blocked` \| `attention`/)
  })

  it('makes the agent the setup wizard', () => {
    expect(skill.indexOf('## Set Notifai up')).toBeGreaterThan(skill.indexOf('## When to notify'))
    expect(skill.indexOf('## Set Notifai up')).toBeLessThan(skill.indexOf('## Compose and send'))
    expect(skill).toContain('Never tell the user to run')
    expect(skill).toContain('notifai init')
    expect(skill).toContain('notifai hooks install')
    expect(skill).toContain('notifai doctor')
    expect(skill).toContain('notifai login')
    expect(skill).toContain('Ask the user only for decisions a process cannot make')
    expect(skill).not.toContain('relay the exact action')
    expect(harnessReference).toContain('install hooks yourself')
    expect(harnessReference).toContain('run `notifai login` yourself')
    expect(harnessReference).not.toContain('the user must run `notifai login`')
    expect(harnessReference).not.toContain('do not install them without being asked')
  })

  it('teaches one Markdown body, ordered media, and substance-only titles', () => {
    for (const required of [
      'one canonical Markdown body',
      '--body-file <path|->',
      'media:1',
      'maximum 8',
      'Never repeat the type or Project in the title',
      'All 42 tests passed',
    ]) {
      expect(skill).toContain(required)
    }
    expect(skill).not.toContain('--detail')
    expect(skill).not.toContain('Done ·')
    expect(skill).not.toContain('Failed ·')
    expect(skill).not.toContain('Question ·')
  })

  it('treats --sound and --level as overrides, not completeness', () => {
    expect(skill).toMatch(/Do not pass `--sound` or `--level` unless/)
    const examples = [...skill.matchAll(/```(?:bash)?\n([\s\S]*?)```/g)].map((match) => match[1])
    const sendExamples = examples.filter((example) => example.includes('notifai send'))
    expect(sendExamples.length).toBeGreaterThan(0)
    for (const example of sendExamples) {
      expect(example).not.toMatch(/(^|\s)--sound\b/)
      expect(example).not.toMatch(/(^|\s)--level\b/)
    }
  })

  it('documents reply lifecycle, routing, inferred source context, and doctor exits', () => {
    for (const required of [
      '--reply-choice',
      'notifai close <request_id>',
      'notifai devices',
      '--device',
      '--all',
      'Project identity from the invocation directory',
      '--session-id',
      'NOTIFAI_SESSION_ID',
      'Do not mint an id',
      'exit status is nonzero',
    ]) {
      expect(skill).toContain(required)
    }
    expect(skill).not.toContain("require('node:crypto').randomUUID()")
    expect(skill).not.toMatch(/`NOTIFAI_SESSION`/)
  })

  it('turns a registered question into a same-turn work-resumption commitment', () => {
    const askGuidance = skill.slice(
      skill.indexOf('### Register a turn-ending question'),
      skill.indexOf('## Verify delivery and readiness'),
    )

    for (const required of [
      'same turn',
      'each offered answer',
      'unexpected typed answer',
      'work you resume',
      'never as approval',
      'permission prompt',
      'interactive picker',
      'question identity',
      'question text',
      "user's answer",
    ]) {
      expect(askGuidance).toContain(required)
    }
    expect(askGuidance).toMatch(/without asking the user to\s+confirm again/)
  })

  it('requires concrete Agent Acknowledgements before resumed work or turn end', () => {
    const askGuidance = skill.slice(
      skill.indexOf('### Register a turn-ending question'),
      skill.indexOf('## Verify delivery and readiness'),
    )
    const requirement = askGuidance.indexOf('agent_acknowledgement_required')
    const command = askGuidance.indexOf('notifai acknowledge <request_id> --text')
    const resume = askGuidance.indexOf('After sending every required Agent Acknowledgement')

    expect(requirement).toBeGreaterThanOrEqual(0)
    expect(command).toBeGreaterThan(requirement)
    expect(resume).toBeGreaterThan(command)
    for (const required of [
      'immediately',
      'before doing any',
      'of the resumed work',
      'before ending the turn',
      'must be non-empty',
      'concrete work you will do',
      'because of their reply',
      'bare “acknowledged”',
      'one for every request id',
      'disabled',
      'requires no',
      'command',
      'route-neutral and truthful',
    ]) {
      expect(askGuidance).toContain(required)
    }
  })

  it('teaches agents to report config JSON fields instead of paraphrasing defaults', () => {
    expect(skill).toContain('notifai config show --json')
    expect(skill).toContain('{ value, source, summary }')
    expect(skill).toContain('Do not paraphrase')
    expect(skill).not.toContain('config.local.toml')
    expect(skill).toContain('outside the repository')
  })

  it('mentions npx only as a pinned alternative to a real install', () => {
    expect(skill).toContain('npm install -g @raidiant/notifai')
    expect(skill.indexOf('npm install -g @raidiant/notifai')).toBeLessThan(
      skill.indexOf('npx --yes @raidiant/notifai@'),
    )
    expect(skill).toContain('do not present npx as the default')
  })

  it('tells the agent where to look when something did not happen', () => {
    // The log's whole value is diagnostic, so the skill has to name the case
    // that produces it — a question that was registered and never travelled.
    expect(skill).toContain('notifai logs')
    expect(skill).toContain('--request <id>')
    expect(skill).toContain('hook.gate')
    expect(skill).toContain('notifications-off')
    // And that it is the user's data, on the user's machine.
    expect(skill).toContain('stays on this machine')
  })

  it('moves per-harness mechanics into progressive disclosure', () => {
    expect(skill).toContain('[Harness setup and recovery](references/harness-setup.md)')
    for (const harness of ['Claude Code', 'Codex', 'Cursor', 'OpenCode']) {
      expect(harnessReference).toContain(`**${harness}:**`)
    }
  })
})
