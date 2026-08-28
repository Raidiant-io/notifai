import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NOTIFICATION_KINDS } from '@raidiant/notifai-protocol'
import { GATE_REASONS } from './hooks.js'

/**
 * These tests assert what the skill has to teach, not the sentences it teaches
 * it in — as far as that is achievable. Pinning wording makes every
 * improvement to the guidance look like a regression, which is how guidance
 * goes stale: the cheapest way to keep a suite green becomes leaving the prose
 * alone.
 *
 * What is genuinely structural: section order, the vocabularies the CLI can
 * actually emit (`NOTIFICATION_KINDS`, `GATE_REASONS`), the token budget, that
 * every example would pass the CLI's own validation, and that every command an
 * agent needs is reachable.
 *
 * Some assertions do match on phrases, and honestly so: a rule like "never say
 * where the answer must arrive" has no structural signature, and the cost of
 * it silently disappearing is higher than the cost of rewording a regex. Those
 * are matched case-insensitively and loosely on purpose.
 */

const skillPath = new URL('../../../skills/notifai/SKILL.md', import.meta.url)
const skill = readFileSync(skillPath, 'utf8')
const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? ''
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
  it('routes proactively in owner sessions without turning ordinary workers into senders', () => {
    // The frontmatter description is the only skill text available during
    // automatic selection. It must select parent owners and workers given
    // explicit delegation without selecting every ordinary worker.
    expect(description).toMatch(/every agent session that owns User-visible Notification Requests/i)
    expect(description).toMatch(/parent owns by default/i)
    expect(description).toMatch(/worker only when ownership is explicitly delegated/i)
    expect(description).toMatch(/even when the user does not mention (?:Notifai|it)/i)
    expect(description).toMatch(/guidance/i)

    const decide = section('## Decide whether to notify')
    expect(decide).toMatch(/owner session lifecycle context normally includes.*effective\s+guidance/is)
    expect(decide).toMatch(/context is absent.*read it once before judging an Agent\s+Event/is)
    expect(decide).toMatch(/parent owns by default/i)
    expect(decide).toMatch(/explicit textual\s+delegation makes a worker the owner/i)
    expect(decide).toMatch(/ordinary workers[\s\S]{0,100}do not load or send/i)
  })

  it('preserves the original Agent Event across setup and ambiguous delivery', () => {
    expect(skill).toMatch(
      /interrupted or killed `send`[\s\S]*do not correlate redacted logs by title[\s\S]*re-run the exact semantic send with\s+`--retry`/i,
    )
    expect(skill).toMatch(/opaque matching attempt[\s\S]*refuse ambiguity/i)
    expect(skill).toMatch(/`no_active_devices`[\s\S]*repeat the\s+(?:exact\s+)?original send/i)
    expect(skill).toMatch(/verification Notification[\s\S]*does not deliver\s+the original Agent Event/i)
  })

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

  it('keeps session instructions out of config and agent paraphrase out of guidance', () => {
    // The rule this pins: a conversational instruction is followed, not
    // persisted, and persisted guidance holds the user's words verbatim. An
    // agent once turned "guide me when you need me" into a persisted standing
    // instruction in its own wording, silently via --yes.
    const decide = section('## Decide whether to notify')
    expect(decide).toMatch(/never touches config/i)
    expect(decide).toMatch(/words\s+verbatim/i)
    expect(decide).toMatch(/paraphrase must never masquerade/i)
    expect(decide).toMatch(/`--yes` skips the\s+CLI's confirmation/i)
  })

  it('sends the agent to the resolved guidance before it writes anything', () => {
    // The writing guidance itself lives in `notifai guidance` (shipped topics,
    // user-overridable per layer); the skill's job is to make reading it the
    // first step and user layers authoritative.
    const decide = section('## Decide whether to notify')
    expect(decide).toContain('notifai guidance')
    for (const topic of ['when-to-notify', 'titles', 'bodies', 'questions', 'acknowledgements']) {
      expect(decide).toContain(`\`${topic}\``)
    }
    const authorityOrder = ['from=you', 'from=this repository', 'from=shipped default'].map(
      (marker) => decide.indexOf(marker),
    )
    expect(authorityOrder[0]).toBeGreaterThan(decide.indexOf('notifai guidance'))
    expect(authorityOrder[1]).toBeGreaterThan(authorityOrder[0]!)
    expect(authorityOrder[2]).toBeGreaterThan(authorityOrder[1]!)
  })

  it('separates repository policy from the User and makes non-exfiltration absolute', () => {
    const decide = section('## Decide whether to notify')
    const markers = ['from=you', 'from=this repository', 'from=shipped default']
    const markerPositions = markers.map((marker) => decide.indexOf(marker))
    expect(markerPositions.every((position) => position >= 0)).toBe(true)

    const numberedLimits = [
      ...decide.matchAll(/^\d+\. \*\*([^*]+)\.\*\*([\s\S]*?)(?=^\d+\. |\n\n)/gm),
    ]
    expect(numberedLimits.map((match) => match[1]?.toLowerCase())).toEqual([
      'non-exfiltration',
      'repository authority',
    ])

    const normalize = (value: string | undefined): string =>
      (value ?? '').toLowerCase().replace(/\s+/g, ' ')
    const nonExfiltration = normalize(numberedLimits[0]?.[2])
    for (const protectedClass of [
      'credential',
      'token',
      'key',
      'password',
      'environment',
      'configuration',
      'guidance',
      'log',
    ]) {
      expect(nonExfiltration, protectedClass).toContain(protectedClass)
    }
    for (const outboundField of [
      'notification request',
      'question',
      'choice',
      'acknowledgement',
      'image',
    ]) {
      expect(nonExfiltration, outboundField).toContain(outboundField)
    }

    const authority = normalize(numberedLimits[1]?.[2])
    for (const protectedAuthority of [
      'standing word',
      'settings',
      'guidance',
      'cli',
      'origins',
      'direct user instruction',
    ]) {
      expect(authority, protectedAuthority).toContain(protectedAuthority)
    }

    const obligations = normalize(decide.slice(numberedLimits[1]?.index ?? 0))
    const refuse = obligations.indexOf('refuse')
    const report = obligations.indexOf('tell the user')
    const noOutboundReport = obligations.search(
      /(?:do not|never|cannot)[^.]{0,120}notification request/,
    )
    expect(refuse).toBeGreaterThanOrEqual(0)
    expect(report).toBeGreaterThan(refuse)
    expect(noOutboundReport).toBeGreaterThan(report)
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

  it('routes a blocker through a question whenever the User response resumes the work', () => {
    // `blocked` and `question` are mutually exclusive on the wire. The skill
    // must teach the selection boundary or an imperative such as "unlock it"
    // becomes an unanswerable one-way notification.
    const selection = `${section('## Send')}\n${section('## Ask a question')}`
    expect(selection).toMatch(/work needs a User response[\s\S]{0,160}answerable\s+question/i)
    expect(selection).toMatch(/one-way blocked[\s\S]{0,160}no\s+User\s+reply\s+would\s+resume/i)
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
    expect(send).toMatch(/kind and the project travel as their own\s+fields, never in it/i)
  })

  it('keeps initial labels stable and teaches the narrow exact-session rename exception', () => {
    const send = section('## Send')
    expect(send).toContain('--session-label')
    expect(send).toMatch(/2-6 words/i)
    expect(send).toMatch(/when the current environment exposes its exact\s+identifier/i)
    expect(send).toMatch(/without an exact Agent Session[\s\S]{0,160}usage\s+error/i)
    expect(send).toMatch(/omit `--session-label`/i)
    expect(send).toMatch(/name the\s+environment supplies wins/i)
    expect(send).toMatch(/freezes one semantic name/i)
    expect(send).toMatch(/safe to repeat the same `--session-label` on every send and ask/i)
    // The one exception to permanence: garbage names are recoverable.
    expect(send).toMatch(/generated fallback name[\s\S]*replaced by a later\s+semantic name/i)
    expect(send).toMatch(/never pass\s+`--session-id`/i)
    expect(send).toMatch(/identifier, hash, or\s+filesystem path/i)
    expect(send).toContain('notifai session rename')
    expect(send).toMatch(/job changed completely[\s\S]{0,100}current\s+name would now mislead/i)
    expect(send).toMatch(/never rename for milestones, ordinary progress/i)
    expect(send).toMatch(/accepts no Agent Session id/i)
    expect(send).toMatch(/active harness proves the exact current Agent Session/i)
  })

  it('never teaches by enumerating environments the CLI can detect itself', () => {
    // "What if we had 24 different plugins, are we gonna list them all?" —
    // guidance states one rule; the mechanism owns environment detection.
    // Harness names may appear only in setup/routing material, where the
    // harness IS the subject.
    for (const heading of ['## Decide whether to notify', '## Send', '## Ask a question', '## When the answer arrives']) {
      expect(section(heading), heading).not.toMatch(/OpenCode|Orca|Cursor|Codex|Hermes/)
    }
  })

  it('separates how long the command waits from how long an answer is accepted', () => {
    const ask = section('## Ask a question')
    expect(ask).toContain('--reply-timeout')
    expect(ask).toContain('--reply-window')
    expect(ask).toMatch(/exit code 3/i)
  })

  it('teaches that closed choices appear after pressing and holding', () => {
    const ask = section('## Ask a question')
    expect(ask).toMatch(/closed choices appear after pressing and holding the\s+notification/i)
    expect(skill).not.toMatch(/choices are buttons on the banner/i)
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

  it('teaches retirement of a registration that has not been pushed yet', () => {
    expect(skill).toContain('notifai close --pending')
    expect(skill).toContain('question_id')
    expect(skill).toMatch(/answer\s+in the conversation/i)
  })

  it('makes the agent the operator and the human only the human', () => {
    const setup = section('## Set Notifai up')
    expect(setup).toMatch(/never tell the\s+user to run a command you could have run/i)
    expect(setup).toMatch(/browser/i)
    expect(setup).toMatch(/companion/i)
    const decisions = setup.search(/both user decisions/i)
    const init = setup.indexOf('notifai init --setup-scope')
    expect(decisions).toBeGreaterThan(0)
    expect(init).toBeGreaterThan(decisions)
    expect(setup).toMatch(/setup scope[\s\S]*this project[\s\S]*every project here/i)
    expect(setup).toMatch(/Question Routing[\s\S]*devices[\s\S]*terminal/i)
    expect(setup).toContain('<--hooks|--no-hooks>')
    expect(setup).not.toMatch(/```bash\s+notifai init --json/m)
    expect(setup).toMatch(/do not follow a successful structured init\s+with doctor/i)
    expect(setup).toContain('--setup-scope')
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
      'notifai init',
      'notifai config show',
      'notifai guidance',
      'notifai logs',
      'notifai status',
    ]) {
      expect(skill, `${command} is unreachable from the skill`).toContain(command)
    }
  })

  it('moves per-harness mechanics into progressive disclosure', () => {
    expect(skill).toContain('[Harness setup and recovery](references/harness-setup.md)')
    expect(skill).toMatch(/read it when you are\s+installing hooks or diagnosing routing/i)
    for (const harness of ['Claude Code', 'Codex', 'Cursor', 'OpenCode', 'Hermes']) {
      expect(harnessReference).toContain(`**${harness}:**`)
    }
    expect(harnessReference).toMatch(/exact `HERMES_SESSION_ID`/i)
    expect(harnessReference).toMatch(/Do not run `notifai hooks install --harness hermes`/i)
    expect(harnessReference).toMatch(/blocking `notifai send --reply`/i)
    expect(harnessReference).toMatch(/npx skills/i)
    expect(harnessReference).toMatch(/no Hermes plugin may vendor/i)
    // The agent runs what a process can run; the human only does the human part.
    expect(harnessReference).toMatch(/let init install and assess\s+the hooks/i)
    expect(harnessReference).toContain('--setup-scope <project|global>')
    expect(harnessReference).not.toContain('--setup-scope project')
    expect(harnessReference).toMatch(/run `notifai login` yourself/i)
    expect(harnessReference).toMatch(/only the user can approve/i)
  })
})
