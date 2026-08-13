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

  it('teaches kind profiles and a correctly classified completion', () => {
    expect(skill).toContain('--kind done')
    expect(skill).toContain('| `update` (default) | `none` | `passive` |')
    expect(skill).toContain('| `done` | `done` | `passive` |')
    expect(skill).toContain('| question (`--reply`) | `attention` | `active` |')
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

  it('treats --sound and --level as overrides, not completeness', () => {
    expect(skill).toMatch(/Never pass `--sound` or `--level` unless/)
    const examples = [...skill.matchAll(/```(?:bash)?\n([\s\S]*?)```/g)].map((match) => match[1])
    const sendExamples = examples.filter((example) => example.includes('notifai send'))
    expect(sendExamples.length).toBeGreaterThan(0)
    for (const example of sendExamples) {
      expect(example).not.toMatch(/(^|\s)--sound\b/)
      expect(example).not.toMatch(/(^|\s)--level\b/)
    }
  })

  it('documents reply lifecycle, routing, session minting, and doctor exits', () => {
    for (const required of [
      '--reply-choice',
      'notifai close <request_id>',
      'notifai devices',
      '--device',
      '--all',
      "require('node:crypto').randomUUID()",
      'exit status is nonzero',
    ]) {
      expect(skill).toContain(required)
    }
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
      'work you will resume',
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
