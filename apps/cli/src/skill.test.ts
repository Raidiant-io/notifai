import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NOTIFICATION_KINDS } from '@raidiant/notifai-protocol'
import { GATE_REASONS } from './hooks.js'

/**
 * These tests assert the *contract* the skill has to teach, not the sentences
 * it teaches it in. An assertion that pins wording makes every improvement to
 * the guidance look like a regression, which is how guidance goes stale: the
 * cheapest way to keep the suite green becomes leaving the prose alone.
 *
 * So: order, vocabulary, obligations, budget, and agreement with the CLI —
 * never phrasing.
 */

const skillPath = new URL('../../../skills/notifai/SKILL.md', import.meta.url)
const skill = readFileSync(skillPath, 'utf8')
const harnessReference = readFileSync(
  new URL('../../../skills/notifai/references/harness-setup.md', import.meta.url),
  'utf8',
)

/** Fenced blocks, so examples can be checked as commands rather than as text. */
const examples = [...skill.matchAll(/```(?:bash|json)?\n([\s\S]*?)```/g)].map((match) => match[1]!)
const shellExamples = examples.flatMap((block) =>
  block
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('notifai ')),
)

const section = (heading: string): string => {
  const start = skill.indexOf(heading)
  if (start < 0) return ''
  const next = skill.indexOf('\n## ', start + heading.length)
  return skill.slice(start, next < 0 ? undefined : next)
}

describe('Notifai agent skill', () => {
  it('fits inside the budget a skill is actually read within', () => {
    // Long skills are truncated in exactly the long sessions that need them.
    // The old skill sat at ~4,800 tokens; this ceiling keeps a working margin.
    const approximateTokens = skill.length / 4
    expect(approximateTokens).toBeLessThan(4_400)
  })

  it('decides whether to notify before it composes anything', () => {
    const decide = skill.search(/^## .*notify/im)
    const compose = skill.search(/^## Send/im)
    expect(decide).toBeGreaterThan(0)
    expect(decide).toBeLessThan(compose)
  })

  it('names every notification kind the CLI accepts', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(skill).toContain(`\`${kind}\``)
    }
  })

  it('teaches kind as required, truthful, and attention-bearing', () => {
    const send = section('## Send')
    expect(send).toMatch(/`--kind` is required/i)
    // The rule that replaced "kind never chooses attention": since kind now
    // selects the sound, the only defensible instruction is to declare the
    // true one.
    expect(send).toMatch(/declare the kind\s+that is true/i)
    expect(skill).not.toMatch(/kind never chooses/i)
  })

  it('keeps every send example valid against the CLI it documents', () => {
    const sends = shellExamples.filter((line) => line.startsWith('notifai send'))
    expect(sends.length).toBeGreaterThan(0)
    for (const example of sends) {
      // Exactly the boundary rule `sendCommand` enforces.
      expect(example, example).toMatch(/--kind |--reply\b/)
      // Attention overrides belong to the user, so no example models one.
      expect(example, example).not.toMatch(/(^|\s)--(sound|level)\b/)
    }
  })

  it('teaches the summary line, the one canonical body, and ordered evidence', () => {
    const send = section('## Send')
    expect(send).toContain('--subtitle')
    expect(send).toContain('--body-file')
    expect(send).toMatch(/one canonical Markdown body/i)
    expect(send).toContain('media:1')
    // Type and project are structured fields, never title text.
    expect(send).toMatch(/never\s+put the kind or the project in it/i)
  })

  it('separates how long the command waits from how long an answer is accepted', () => {
    const ask = section('## Ask a question')
    expect(ask).toContain('--reply-timeout')
    expect(ask).toContain('--reply-window')
    expect(ask).toMatch(/exit code 3/i)
  })

  it('makes registration the middle of the asking turn, not the end', () => {
    const ask = section('## Ask a question')
    expect(ask).toMatch(/registering is not the end of the turn/i)
    // The pre-commitment, and the route-neutrality that makes it survive.
    expect(ask).toMatch(/what each answer will make you do/i)
    expect(ask).toMatch(/never say where the answer must arrive/i)
    expect(ask).toMatch(/tell me here/i)
  })

  it('requires an acknowledgement before any resumed work', () => {
    const answers = section('## When the answer arrives')
    const acknowledge = answers.indexOf('notifai acknowledge')
    const resume = answers.search(/then resume/i)
    expect(acknowledge).toBeGreaterThanOrEqual(0)
    expect(resume).toBeGreaterThan(acknowledge)
    expect(answers).toMatch(/acknowledge before you resume/i)
    // Unconditional: no "if required" escape hatch survives the decision that
    // the user always learns their reply was read.
    expect(answers).not.toMatch(/if .{0,24}acknowledgement is required/i)
    expect(answers).toMatch(/concrete/i)
  })

  it('keeps the relay honest about transport, authorship, and its limits', () => {
    const answers = section('## When the answer arrives')
    expect(answers).toMatch(/latest reply/i)
    expect(answers).toMatch(/another session/i)
    expect(answers).toMatch(/permission prompt/i)
    expect(answers).toMatch(/without asking them to confirm again/i)
  })

  it('recovers an answer it was never handed', () => {
    expect(skill).toContain('notifai replies --pending')
  })

  it('makes the agent the operator and the human only the human', () => {
    const setup = section('## Set Notifai up')
    expect(setup).toMatch(/never tell the\s+user to run a command you could have run/i)
    expect(setup).toMatch(/browser/i)
    expect(setup).toMatch(/companion/i)
    expect(setup).toContain('notifai doctor --json')
    expect(setup).toContain('notifai init')
  })

  it('offers npx only as a pinned fallback behind a real install', () => {
    const global = skill.indexOf('npm install -g @raidiant/notifai')
    const npx = skill.indexOf('npx --yes @raidiant/notifai@')
    expect(global).toBeGreaterThan(0)
    expect(global).toBeLessThan(npx)
    expect(skill).toMatch(/never as the first suggestion/i)
  })

  it('gives the agent an exit-status branch for every documented outcome', () => {
    for (const code of ['| 0 |', '| 1 |', '| 2 |', '| 3 |', '| 4 |', '| 5 |']) {
      expect(skill).toContain(code)
    }
    expect(skill).toMatch(/`notifai <command> --help` is the authoritative list/i)
  })

  it('points at the record when something did not happen, and calls it private', () => {
    const check = section('## Check what happened')
    expect(check).toContain('notifai logs')
    expect(check).toContain('hook.gate')
    expect(check).toMatch(/never leaves the machine/i)
  })

  it('advertises exactly the gate reasons the code can emit', () => {
    // The drift this replaces: the skill advertised `already-asked` and
    // `no-devices` for months, neither of which was ever emitted, while
    // `answered`, `acknowledgement-required` and `proceeding` went undocumented.
    // Reading the vocabulary from the code makes that impossible to repeat.
    const check = section('## Check what happened')
    const documented = [...check.matchAll(/`([a-z]+(?:-[a-z]+)*)`/g)].map((m) => m[1]!)
    const advertised = new Set(documented.filter((word) => GATE_REASONS.includes(word as never)))
    for (const reason of GATE_REASONS) {
      // `elapsed` is debug-only bookkeeping, not a routing verdict an agent acts on.
      if (reason === 'elapsed') continue
      expect(advertised, `gate reason ${reason} is not documented`).toContain(reason)
    }
    for (const word of documented) {
      if (!word.includes('-')) continue
      const looksLikeAReason = /^(no|already|continuation|delivery|claimed|notifications|acknowledgement)-/.test(word)
      if (!looksLikeAReason) continue
      expect(GATE_REASONS, `the skill advertises "${word}", which nothing emits`).toContain(word)
    }
  })

  it('distinguishes acceptance, receipt, and unknown when reporting delivery', () => {
    const check = section('## Check what happened')
    expect(check).toMatch(/provider acceptance/i)
    expect(check).toMatch(/companion receipt/i)
    expect(check).toMatch(/unknown/i)
  })

  it('covers every command an agent needs to reach the user and recover', () => {
    for (const command of [
      'notifai send',
      'notifai ask',
      'notifai replies',
      'notifai acknowledge',
      'notifai close',
      'notifai doctor',
      'notifai init',
      'notifai config show',
      'notifai logs',
      'notifai status',
    ]) {
      expect(skill, `${command} is unreachable from the skill`).toContain(command)
    }
  })

  it('moves per-harness mechanics into progressive disclosure', () => {
    expect(skill).toContain('[Harness setup and recovery](references/harness-setup.md)')
    expect(skill).toMatch(/read it when you are\s+installing hooks or diagnosing routing/i)
    for (const harness of ['Claude Code', 'Codex', 'Cursor', 'OpenCode']) {
      expect(harnessReference).toContain(`**${harness}:**`)
    }
    // The agent runs what a process can run; the human only does the human part.
    expect(harnessReference).toContain('install hooks yourself')
    expect(harnessReference).toMatch(/run `notifai login` yourself/i)
    expect(harnessReference).toMatch(/only the user can approve/i)
  })
})
