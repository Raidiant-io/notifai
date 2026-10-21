import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NOTIFICATION_KINDS } from '@raidiant/notifai-protocol'
import { GATE_REASONS } from './hook-gates.js'

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
const HARNESS_FILES = ['claude-code', 'codex', 'cursor', 'opencode', 'openclaw', 'hermes', 'grok'] as const
const harnessFile = (name: (typeof HARNESS_FILES)[number]): string => readFileSync(
  new URL(`../../../skills/notifai/references/harness-${name}.md`, import.meta.url), 'utf8',
)
const harnessSetupReference = readFileSync(
  new URL('../../../skills/notifai/references/harness-setup.md', import.meta.url),
  'utf8',
)
/** What every harness shares, then each harness's own file. */
const harnessReference = [harnessSetupReference, ...HARNESS_FILES.map(harnessFile)].join('\n')
const diagnosticsReference = readFileSync(
  new URL('../../../skills/notifai/references/diagnostics.md', import.meta.url),
  'utf8',
)
const sendDetailsReference = readFileSync(
  new URL('../../../skills/notifai/references/send-details.md', import.meta.url),
  'utf8',
)
const referencesDir = new URL('../../../skills/notifai/references/', import.meta.url)
const nativeQuestionsReference = readFileSync(new URL('native-questions.md', referencesDir), 'utf8')
/** The skill and the references it links: everything an agent can reach from it. */
const reachable = [skill, harnessReference, diagnosticsReference, sendDetailsReference].join('\n')
const rootReadme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
const cliReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

/** Fenced blocks, so examples can be checked as commands rather than as text. */
const examples = [...skill.matchAll(/```(?:bash|json)?\n([\s\S]*?)```/g)].map((match) => match[1]!)
const shellExamples = examples.flatMap((block) =>
  block
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('notifai ')),
)

/** Lines joined within each paragraph, so a rule matches however the prose wraps. */
const loose = (text: string): string => text.replace(/([^\n])\n(?=[^\n])/g, '$1 ')

const rawSection = (heading: string): string => {
  const start = skill.indexOf(heading)
  if (start < 0) return ''
  const next = skill.indexOf('\n## ', start + heading.length)
  return skill.slice(start, next < 0 ? undefined : next)
}
const section = (heading: string): string => loose(rawSection(heading))

describe('Notifai agent skill', () => {
  it('routes proactively in owner sessions without turning ordinary workers into senders', () => {
    // The frontmatter description is the only skill text available during
    // automatic selection. It must select parent owners and workers given
    // explicit delegation without selecting every ordinary worker.
    expect(description).toMatch(/for Notification Request owners/i)
    expect(description).toMatch(/parent owns by default/i)
    expect(description).toMatch(/workers only by explicit delegation/i)
    expect(description).toMatch(/does not mention Notifai/i)
    expect(description).toMatch(/guidance/i)
    for (const trigger of ['decision', 'approval', 'sign-in', 'credential setup', 'physical action', 'substantial work']) {
      expect(description, trigger).toContain(trigger)
    }
    expect(description).toMatch(/User was recently active/i)

    const decide = section('## Decide whether to notify')
    expect(decide).toMatch(/owner session context carries/i)
    expect(decide).toMatch(/context is absent[\s\S]*run this once/i)
    expect(decide).toMatch(/parent owns by default/i)
    expect(decide).toMatch(/explicit delegation makes a worker the owner/i)
    expect(decide).toMatch(/ordinary workers[\s\S]{0,100}do not load or send/i)
  })

  it('preserves the original Agent Event across setup and ambiguous delivery', () => {
    expect(loose(skill)).toMatch(
      /interrupted or killed `send`[\s\S]*do not correlate redacted logs by title[\s\S]*re-run the exact semantic send with\s+`--retry`/i,
    )
    expect(loose(skill)).toMatch(/opaque matching attempt[\s\S]*refuse ambiguity/i)
    expect(loose(skill)).toMatch(/`no_active_devices`[\s\S]*repeat the\s+(?:exact\s+)?original send/i)
    expect(loose(skill)).toMatch(/verification Notification[\s\S]*does not deliver\s+the original Agent Event/i)
  })

  it('fits inside the budget a skill is actually read within, with room to grow', () => {
    // Long skills are truncated in exactly the long sessions that need them.
    // The old skill sat at ~4,800 tokens; the ceiling keeps a working margin,
    // and the core text stays at least 10% under it: detail belongs in
    // references, not in a skill with no room for its next rule.
    const approximateTokens = skill.length / 4
    expect(approximateTokens).toBeLessThan(4_400)
    expect(approximateTokens).toBeLessThanOrEqual(4_400 * 0.9)
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
    expect(decide).toMatch(/paraphrase\s+must never masquerade/i)
    expect(decide).toMatch(/`--yes` skips the\s+CLI's confirmation/i)
  })

  it('sends the agent to the resolved guidance before it writes anything', () => {
    // Session context carries the topics that decide whether to notify; the
    // wording topics are read with `notifai guidance` before the first
    // Notification Request. The skill names both halves, the command, and
    // both provenance markers, and claims no ordering.
    const decide = section('## Decide whether to notify')
    expect(decide).toContain('notifai guidance')
    const carried = decide.slice(0, decide.indexOf('notifai guidance'))
    for (const topic of ['when-to-notify', 'questions']) expect(carried).toContain(`\`${topic}\``)
    expect(decide).toMatch(/before your\s+first Notification Request/i)
    const added = decide.slice(decide.indexOf('notifai guidance'))
    for (const topic of ['titles', 'content', 'acknowledgements']) expect(added).toContain(`\`${topic}\``)
    for (const marker of ['from=you', 'from=shipped default']) {
      expect(added).toContain(marker)
    }
    expect(decide).not.toContain('from=this repository')
    expect(decide).not.toMatch(/ordered by/i)
  })

  it('makes non-exfiltration absolute against every instruction, a repository file included', () => {
    const decide = section('## Decide whether to notify')
    const normalize = (value: string | undefined): string =>
      (value ?? '').toLowerCase().replace(/\s+/g, ' ')
    const limits = [...decide.matchAll(/^\*\*([^*]+)\.\*\*([\s\S]*?)(?=\n\n)/gm)]
    expect(limits.map((match) => match[1]?.toLowerCase())).toEqual(['non-exfiltration'])

    const limit = normalize(limits[0]?.[2])
    // Whatever asks: a topic, a repository file, or any other instruction.
    for (const source of ['topic', 'repository file', 'other instruction']) {
      expect(limit, source).toContain(source)
    }
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
      expect(limit, protectedClass).toContain(protectedClass)
    }
    for (const outboundField of [
      'notification request',
      'question',
      'choice',
      'acknowledgement',
      'image',
    ]) {
      expect(limit, outboundField).toContain(outboundField)
    }

    // Refuse, then tell the User, then never turn the report into a send.
    const refuse = limit.indexOf('refuse')
    const report = limit.indexOf('tell the user')
    const noOutboundReport = limit.search(/(?:do not|never|cannot)[^.]{0,120}notification request/)
    expect(refuse).toBeGreaterThanOrEqual(0)
    expect(report).toBeGreaterThan(refuse)
    expect(noOutboundReport).toBeGreaterThan(report)

    // No repository authority is left to limit or to write to.
    expect(decide).not.toMatch(/repository authority|house rules/i)
    expect(skill).not.toMatch(/--project\b(?! <id>)/)
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
    expect(selection).toMatch(/needs a User response[\s\S]{0,160}`notifai ask`/i)
    expect(selection).toMatch(/`blocked` \| waiting, and no User reply would resume the work; otherwise \[ask\]\(#ask-a-question\)/)
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

  it('teaches the required Summary, optional Markdown Body, and ordered evidence', () => {
    const send = section('## Send')
    expect(send).toContain('--summary')
    expect(send).not.toContain('--subtitle')
    expect(send).toContain('--body-file')
    expect(send).toMatch(/optional standalone Markdown for focused detail/i)
    expect(send).toContain('media:1')
    expect(send).toContain('[Sending details](references/send-details.md)')
    expect(sendDetailsReference).toMatch(/Bare `media:1`[\s\S]*is an error/)
    expect(sendDetailsReference).toMatch(/belong to the User/)
    // Type and project are structured fields, never title text.
    expect(send).toMatch(/kind and the project travel as their own\s+fields, never in it/i)
    // The wire facts live here, in fixed text, never only in an overridable topic.
    expect(send).toMatch(/Summary\*\*: required one-line plain text/i)
    expect(send).toMatch(/at most 240\s+Unicode characters/i)
    expect(send).toMatch(/never both/i)
    expect(send).toContain('(references/writing-examples.md)')
    // A Body that a shell would mangle, or approval rules would not match,
    // goes through a file outside the repository, with the reason.
    expect(send).toMatch(/system temp directory, never the repository/i)
    expect(send).toMatch(/approval rules match only a plain `notifai …`\s+argument list/i)
  })

  it('keeps initial labels stable and teaches the narrow exact-session rename exception', () => {
    const send = section('## Send')
    expect(send).toContain('--session-label')
    expect(send).toMatch(/2-6 words/i)
    expect(send).toMatch(/when the current environment exposes its exact\s+identifier/i)
    expect(send).toMatch(/without an exact Agent Session[\s\S]{0,160}usage\s+error/i)
    expect(send).toMatch(/without that identifier, omit\s+`--session-label`/i)
    expect(send).toMatch(/pass the same `--session-label` on every send and ask; to rename, use\s+`notifai session rename`/i)
    expect(send).toMatch(/never pass\s+`--session-id`/i)
    expect(send).toMatch(/identifier, hash, or\s+filesystem path/i)
    expect(send).toContain('notifai session rename')
    expect(send).toMatch(/job changed completely[\s\S]{0,100}old name would mislead/i)
    expect(send).toMatch(/without\s+waiting for a notification or User reminder/i)
    expect(send).toMatch(/keep the name for milestones,\s+ordinary progress, and same-job refinements/i)
    expect(send).toMatch(/(?:accepts|takes) no Agent Session id/i)
    expect(send).toMatch(/active harness (?:to|must)\s+prove the exact (?:current Agent )?session/i)
  })

  it('never teaches by enumerating environments the CLI can detect itself', () => {
    // "What if we had 24 different plugins, are we gonna list them all?" —
    // guidance states one rule; the mechanism owns environment detection.
    // Harness names may appear only in setup/routing material, where the
    // harness IS the subject. Until `ask` hands back the picker, the question
    // procedure keeps its one Claude Code exception.
    for (const heading of ['## Decide whether to notify', '## Send', '## Ask a question', '## When the answer arrives']) {
      expect(section(heading), heading).not.toMatch(/Codex|Cursor|OpenCode|OpenClaw|Hermes|Grok|Orca/)
    }
    expect(section('## Ask a question').match(/Claude Code/g)?.length).toBe(1)
  })

  it('keeps resumable ask the default and send --reply the bounded foreground wait', () => {
    const ask = section('## Ask a question')
    const resumable = ask.search(/work you own or coordinate needs a User response, use `notifai ask`/i)
    const foreground = ask.indexOf('### Bounded foreground wait')
    expect(resumable).toBeGreaterThan(0)
    expect(foreground).toBeGreaterThan(resumable)
    expect(ask).toMatch(/`ask` keeps the return path for the complete answer window/i)
    expect(ask).toMatch(/`send --reply` is a bounded foreground wait, not a resumable handoff/i)
    expect(ask).toContain('--reply-timeout')
    expect(ask).toContain('--reply-window')
    expect(ask).toMatch(/foreground owner stays alive through\s+the complete answer window and `--reply-timeout` equals `--reply-window`/i)
    expect(ask).toMatch(/exit 3 means no answer arrived in the bounded wait[\s\S]{0,80}does not resume later/i)
    const example = ask.match(/```bash\n(notifai send --reply[\s\S]*?)```/)?.[1] ?? ''
    expect(Number(example.match(/--reply-timeout\s+(\d+)/)?.[1])).toBe(Number(example.match(/--reply-window\s+(\d+)/)?.[1]))
    expect(skill).not.toContain('ask --wait')
  })

  it('keeps exit 3 attached to the original bounded wait', () => {
    const row = skill.match(/^\| 3 \|([^\n]+)$/m)?.[1] ?? ''
    expect(row).toMatch(/bounded wait timed out/i)
    expect(row).toMatch(/keep its ID; inspect the original with `replies`\/`status`, never duplicate it/i)
    expect(skill.match(/^\| 5 \|([^\n]+)$/m)?.[1] ?? '').toMatch(/for `send`, rerun the exact command with `--retry`/i)
    // The SKILL row and the command's own output are the only homes.
    for (const name of HARNESS_FILES) expect(harnessFile(name), name).not.toMatch(/exit 3/i)
    expect(harnessSetupReference).not.toMatch(/exit 3/i)
    // A withdrawn or expired question is never asked again on a guess.
    for (const text of [skill, harnessSetupReference, ...HARNESS_FILES.map(harnessFile)]) {
      expect(text.replace(/\s+/g, ' ')).not.toMatch(/ask again (?:only )?if you still need/i)
    }
  })

  it('registers owned questions in the same turn and authors their choices', () => {
    const ask = section('## Ask a question')
    expect(ask).toMatch(/work you own or coordinate.*User response.*`notifai ask` in\s+the same turn/is)
    expect(ask).toMatch(/conversation alone misses an\s+away User/i)
    const example = rawSection('## Ask a question').match(/```bash\n(notifai ask[\s\S]*?)```/)?.[1] ?? ''
    // The agent writes the title; the question is the Summary beneath it.
    expect(example).toMatch(/--title "Production deploy"/)
    expect(ask).toMatch(/positional question is the Summary: the exact question/i)
    expect(example).toMatch(/--choice-description "/)
    expect(example).toMatch(/--recommended "/)
    expect(ask).toMatch(/always type an answer/i)
    // `--title` is required and the `titles` topic says what it carries; the
    // skill never restates that, and the CLI never copies the question into it.
    expect(ask).toMatch(/write `--title` as the `titles` guidance says for a question/i)
    expect(ask).not.toMatch(/names the decision/i)
    // A form carries its own title, and each question of several its own, shown as its tab.
    expect(sendDetailsReference).toMatch(/"title": "Release plan"/)
    expect(sendDetailsReference).toMatch(/"title": "Ship day", "text": "Ship on Friday\?"/)
    expect(sendDetailsReference.replace(/\s+/g, ' ')).toMatch(/with several questions, each takes a `"title"` of a word or two naming its own decision; a terminal form shows it as that question's tab/i)
  })

  it('says a self-opened form reaches devices only where linked', () => {
    const ask = section('## Ask a question')
    // `ask` hands back no form yet.
    expect(ask).not.toMatch(/hands back/i)
    // A form the agent opens itself carries only its own fields (no Body or
    // images from `ask`), and many reach no device; a form's tool context is
    // the proof where it has one.
    expect(ask).toMatch(/a question form you open yourself carries only its own fields, and reaches the\s+User's devices only where Notifai links it/i)
    expect(ask).toMatch(/when its tool context says Notifai\s+registered it, never also `ask` it/i)
    expect(ask).toMatch(/keep this Agent Session open: closing, clearing or\s+switching it ends the question/i)
    expect(ask).toMatch(/after `notifai ask`, ask in the\s+conversation, say what each answer will make you do, and continue independent\s+work/i)
    expect(ask).toMatch(/never restate the choices in the Body/i)
  })

  it('waits for User-owned hook approval instead of bypassing Question Routing', () => {
    const ask = section('## Ask a question')
    const paragraphs = ask.split(/\n\n+/)
    const approval = paragraphs.find((paragraph) => /trust or permission/i.test(paragraph)) ?? ''
    const disabled = paragraphs.find((paragraph) => /ask_notifications.*off/i.test(paragraph)) ?? ''

    expect(approval).toMatch(/exact.*remedy/is)
    expect(approval).toMatch(/hooks.*(?:trust|approval)/is)
    expect(approval).toMatch(/wait/i)
    expect(approval).toMatch(/never\s+bypass Question Routing with `send --reply`/i)
    expect(loose(harnessSetupReference)).toMatch(/Never bypass that gap with `notifai send --reply`/)
    // "Send questions to my devices" off keeps every question off the devices,
    // on every route: the skill names the setting and teaches no workaround.
    expect(loose(disabled)).toMatch(/“Send questions to my devices” \(`ask_notifications`\) is off, the User keeps questions off their devices: ask in the conversation, or in your own question form, which stays in the terminal\. `send --reply` refuses there too\./)
    expect(disabled).not.toMatch(/deliberately|does not gate/i)
    expect(skill).not.toContain('/hooks')
    expect(harnessReference).toContain('/hooks')
  })

  it('gives an unsupported-harness fallback one full-window foreground owner, never a duplicate', () => {
    const ask = section('## Ask a question')
    expect(ask).toContain('notifai status <question_id|request_id> --json')
    expect(ask).toMatch(/notifai replies <request_id> --json/)
    expect(ask).toMatch(/instead of asking again/i)
    expect(ask).toMatch(/never register an open question again/i)

    expect(loose(harnessSetupReference)).toMatch(/no answer can come back[\s\S]{0,120}names a blocking `notifai send --reply` question/i)
    expect(harnessSetupReference).toMatch(/foreground owner.*alive.*complete answer window/is)
    expect(harnessSetupReference).toMatch(/`--reply-timeout`.*equal.*`--reply-window`/is)
    expect(harnessReference).toContain('notifai replies <request_id> --json')
    expect(harnessReference).toContain('notifai status <request_id> --json')
    expect(harnessReference).not.toContain('ask --wait')
    for (const [name, docs] of [['root README', rootReadme], ['CLI README', cliReadme]] as const) {
      expect(docs, name).toMatch(/send --reply[\s\S]*complete answer window/is)
      expect(docs, name).toMatch(/reply-timeout[\s\S]*equal[\s\S]*reply-window/is)
    }
  })

  it('teaches one Claude Code wake for every platform, with no held Stop', () => {
    const claude = harnessFile('claude-code')
    const answerRoute = claude.slice(claude.indexOf('## What arrives and what to do'), claude.indexOf('## Questions'))

    expect(answerRoute).toMatch(/come back on their own for the whole\s+answer window/i)
    expect(answerRoute).toMatch(/wake-up carries no answer; Claude Code shows it as a\s+message from another session/i)
    expect(answerRoute).toMatch(/macOS and\s+Linux.*Windows.*next turn/is)
    expect(answerRoute).not.toMatch(/stays held|decision: block/i)
    expect(harnessSetupReference).toMatch(/`direct_wake_ready`[\s\S]*optional when a held turn or\s+recovery owns the answer/i)
    expect(harnessSetupReference).toMatch(/`direct_wake_ready`[\s\S]*`null` when nothing assessed it/i)
  })

  it('keeps the rules that protect a waiting question in each harness file', () => {
    const flat = (name: (typeof HARNESS_FILES)[number]) => harnessFile(name).replace(/\s+/g, ' ')
    const claude = flat('claude-code')
    expect(claude).toMatch(/`\/clear`.{0,120}never suggest any of these while a question waits/i)
    expect(claude).toMatch(/possibly hours later: check that the work it answers still applies/i)
    expect(claude).toMatch(/do not ask the user to resume it/i)
    expect(claude).toMatch(/change these only when the user asks/i)
    expect(claude).toMatch(/`claude -p --resume`.{0,30}receives nothing/i)
    expect(claude).toMatch(/never edit Claude Code's permission settings by hand/i)

    const codex = flat('codex')
    expect(codex).toMatch(/`request_user_input` \(no `_async`\) is not linked/)
    expect(codex).toMatch(/never suggest ending a session while one of its questions waits/i)
    expect(codex).toMatch(/possibly hours later: check that the work it answers still applies/i)
    expect(codex).toMatch(/do not ask the user to resume it/i)
    expect(codex).toMatch(/call `notifai` by name, never by absolute path/i)
    expect(codex).toMatch(/finds nothing pending, end the turn; never resume finished work for it/i)
    expect(codex).toMatch(/`\/hooks`/)
  })

  it('stays channel-neutral: no gestures and no devices in the shared procedure', () => {
    // An iPhone-only gesture taught agents a route the User may not have.
    expect(skill).not.toMatch(/press(?:ing)? and hold|long-press|\btap\b|swipe|iPhone|Android|lock screen/i)
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

  it('keeps local registration distinct from submission and delivery evidence', () => {
    const ask = section('## Ask a question')
    expect(ask).toMatch(/`registered: true`[\s\S]{0,180}local/i)
    expect(ask).toMatch(/not submission or\s+Provider Acceptance/i)
    expect(ask).toMatch(/report sending or delivery only from status evidence/i)
    expect(ask).toMatch(/continue independent work/i)
    expect(ask).not.toMatch(/end the turn to start submission/i)
    expect(ask).toContain('notifai status <question_id> --json')
    expect(ask).toMatch(/once submitted, status adds a `request_id`; keep both IDs/i)
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
    expect(loose(skill)).toMatch(/answered\s+in the conversation/i)
  })

  it('records Codex terminal answers itself and keeps the Codex card flow in its references', () => {
    // Notifai records a Codex terminal answer, so no reference teaches a
    // report command; the native questions reference stays for the marker
    // fallback `ask` still returns. Notes and edits are taught by their own text.
    expect(existsSync(new URL('native-questions.md', referencesDir))).toBe(true)
    expect(existsSync(new URL('notes-and-edits.md', referencesDir))).toBe(false)
    expect(skill).toMatch(/native_question[\s\S]*references\/native-questions\.md/)
    expect(skill).not.toMatch(/native answers/i)
    expect(loose(nativeQuestionsReference)).toMatch(/A terminal answer needs nothing from you: Notifai records it, so the devices stop asking/)
    expect(nativeQuestionsReference).not.toMatch(/--native-answers|--operation-id|notifai acknowledge q_|operation ID|app answer watcher/)
    const codex = harnessFile('codex').replace(/\s+/g, ' ')
    expect(codex).toMatch(/terminal answer\*\* needs nothing from you\. Notifai records it, so the devices stop asking/i)
    expect(codex).toMatch(/A terminal answer needs nothing from you; handle the plain-question fallback as \[native questions\]\(native-questions\.md\) says/i)
    expect(codex).not.toMatch(/--native-answers|report a terminal answer/i)
    expect(codex).toMatch(/device answer\*\* arrives in the card with its own `notifai acknowledge req_…` command/i)
    expect(codex).not.toMatch(/hands back|ask --wait/i)
    // Cards that stay in the terminal on purpose get their own outcome, never
    // an `ask` that refuses (questions off, a disabled Project) or fails
    // (signed out).
    expect(codex).toMatch(/with question notifications off, or in a project the User disabled, the card is your question and stays in the terminal, as a card on a signed-out machine does; it still works there/i)
    expect(codex).not.toMatch(/Project that is not enabled|notifai project enable/i)
    expect(codex).toMatch(/any other card without that context, such as one in a shape the devices cannot show, stays on this machine: if it is still unanswered, `ask` the question too/i)
    expect(codex).not.toMatch(/subagent's card/i)
    const opencode = harnessFile('opencode').replace(/\s+/g, ' ')
    expect(opencode).not.toMatch(/worker session's form/i)
    const claude = harnessFile('claude-code').replace(/\s+/g, ' ')
    expect(claude).toMatch(/terminal answer\*\* needs nothing from you/i)
    // On Claude Code the picker is still the route for a closed question.
    expect(claude).toMatch(/ask a question with two to four closed choices through the `AskUserQuestion` picker, not `notifai ask`/i)
    expect(claude).toMatch(/code `use_question_picker`/)
    expect(claude).toMatch(/option previews stay in the terminal/i)
    expect(claude).not.toMatch(/ask --wait|heading, or else its headers|continued while the User was away/i)
    // The User at the terminal chose to talk: continue there, never re-ask.
    expect(claude).toMatch(/Esc, "Chat about this", or a picker another hook denies\*\* withdraws the device question: continue in the conversation/i)
    // The agent learns only that a question expired, never that it was dismissed.
    for (const harness of ['claude-code', 'codex'] as const) {
      expect(harnessFile(harness).replace(/\s+/g, ' ')).toMatch(/question that expired on the devices\*\* closes the (?:picker|card) unanswered/i)
      expect(harnessFile(harness)).not.toMatch(/dismissed on a device/i)
    }
  })

  it('links only files that exist', () => {
    const files = ['SKILL.md', ...readdirSync(referencesDir).map((name) => `references/${name}`)]
    for (const file of files) {
      const text = readFileSync(new URL(`../../../skills/notifai/${file}`, import.meta.url), 'utf8')
      for (const [, target] of text.matchAll(/\]\(((?:references\/)?[a-z-]+\.md)(?:#[^)]*)?\)/g)) {
        const base = file.startsWith('references/') && !target!.startsWith('references/') ? 'references/' : ''
        expect(existsSync(new URL(`../../../skills/notifai/${base}${target}`, import.meta.url)), `${file} -> ${target}`).toBe(true)
      }
    }
  })

  it('makes the agent the operator and the human only the human', () => {
    const setup = section('## Set Notifai up')
    expect(setup).toMatch(/run every command you can run yourself; hand the User only human-only steps/i)
    expect(setup).toMatch(/browser/i)
    expect(setup).toMatch(/companion/i)
    const decisions = setup.search(/two independent decisions remain/i)
    const init = setup.indexOf('notifai init <--hooks|--no-hooks>')
    expect(decisions).toBeGreaterThan(0)
    expect(init).toBeGreaterThan(decisions)
    // The hooks decision says what hooks do; keeping questions in the
    // terminal is its own setting, not "no hooks".
    expect(setup.replace(/\s+/g, ' ')).toMatch(/hooks[\s\S]*in the projects where it is on, questions reach their devices and answers come back/i)
    expect(setup).toMatch(/terminal[\s\S]*`ask_notifications`/i)
    expect(setup).not.toMatch(/whether Question Routing sends questions/i)
    // Lifecycle wiring has one place to go, so the only scope left is the
    // skill's, and the per-project switch is enablement.
    expect(setup).toMatch(/lifecycle wiring has no scope/i)
    expect(setup).toMatch(/notifai project enable/)
    expect(setup).toMatch(/skill[\s\S]*this project[\s\S]*every project here/i)
    expect(setup).toContain('<--hooks|--no-hooks>')
    expect(setup).toContain('--skills-scope <project|global>')
    expect(setup).not.toContain('--setup-scope')
    expect(setup).not.toMatch(/```bash\s+notifai init --json/m)
    // `ask` checks its own route; doctor verifies a fresh session or a failure.
    expect(setup).toMatch(/after a successful `init --json`, carry on/i)
    expect(setup).toMatch(/`notifai doctor` to verify a fresh session/i)
  })

  it('gives the agent an exit-status branch for every documented outcome', () => {
    for (const code of ['| 0 |', '| 1 |', '| 2 |', '| 3 |', '| 4 |', '| 5 |']) {
      expect(skill).toContain(code)
    }
    expect(loose(skill)).toMatch(/`notifai <command> --help` is the authoritative list/i)
  })

  it('points at the record when something did not happen, and calls it private', () => {
    const check = section('## Check what happened')
    expect(check).toContain('notifai logs')
    expect(check).toContain('hook.gate')
    expect(check).toMatch(/never leaves the machine/i)
    expect(check).toContain('[Diagnosing what happened](references/diagnostics.md)')
    expect(diagnosticsReference).toMatch(/never leaves the machine/i)
    expect(diagnosticsReference).toContain('notifai auth access --json')
  })

  it('advertises exactly the gate reasons the code can emit', () => {
    // The drift this replaces: the skill advertised `already-asked` and
    // `no-devices` for months, neither of which was ever emitted, while
    // `answered`, `acknowledgement-required` and `proceeding` went undocumented.
    // Reading the vocabulary from the code makes that impossible to repeat.
    const documented = [...diagnosticsReference.matchAll(/`([a-z]+(?:-[a-z]+)*)`/g)].map((m) => m[1]!)
    const advertised = new Set(documented.filter((word) => GATE_REASONS.includes(word as never)))
    for (const reason of GATE_REASONS) {
      expect(advertised, `gate reason ${reason} is not documented`).toContain(reason)
    }
    for (const word of documented) {
      if (!word.includes('-')) continue
      const looksLikeAReason = /^(no|already|continuation|delivery|claimed|question-notifications|acknowledgement)-/.test(word)
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
      'notifai sounds',
    ]) {
      expect(reachable, `${command} is unreachable from the skill`).toContain(command)
    }
  })

  it('gives each harness its own reference, so an agent reads only the one it is in', () => {
    for (const name of HARNESS_FILES) {
      expect(harnessSetupReference).toContain(`(harness-${name}.md)`)
      expect(harnessFile(name)).toContain('## Activation')
      expect(harnessFile(name)).toContain('(harness-setup.md)')
    }
    for (const lead of ['**Claude Code:**', '**Codex:**', '**OpenClaw:**', '**Hermes:**', '**Grok:**']) {
      expect(harnessSetupReference).not.toContain(lead)
    }
    expect(harnessFile('claude-code')).not.toMatch(/\*\*Codex:\*\*|OpenClaw|Hermes/)
    expect(harnessFile('claude-code')).toContain('notifai init --claude-commands --json')
    expect(harnessFile('codex')).toContain('notifai init --codex-commands --json')
    expect(loose(skill)).toMatch(/--body-file <path>/)
  })

  it('routes a self-opened form in every Project the User has not disabled, and names project disable as the switch', () => {
    // Question Routing works whatever the Project's Enablement, so no
    // reference names an unenabled Project as keeping a form local.
    for (const name of ['claude-code', 'codex', 'opencode', 'openclaw'] as const) {
      expect(harnessFile(name).replace(/\s+/g, ' ')).not.toMatch(/Project (is|that is) not enabled|in an enabled Project; never|needs an enabled Project/i)
    }
    // A disabled Project keeps every self-opened form in the terminal.
    expect(loose(harnessFile('claude-code'))).toMatch(/A picker stays in the terminal when question notifications are off, the machine is not signed in, the User disabled this project, or it runs on Windows/)
    expect(loose(harnessFile('opencode'))).toMatch(/reaches the User's devices by itself; never also register it/)
    expect(loose(harnessFile('opencode'))).toMatch(/A form on a signed-out machine, with question notifications off, in a project the User disabled, or in a shape the devices cannot show stays in OpenCode only/)
    expect(loose(harnessFile('openclaw'))).toMatch(/This needs a local Gateway/)
    // Claude Code gives subagents no picker, so none is named.
    expect(harnessFile('claude-code').replace(/\s+/g, ' ')).not.toMatch(/picker belongs to a subagent/i)
    // Nothing reaches the User's devices from a Project the User disabled, so
    // disabling turns Notifai off there.
    expect(loose(harnessSetupReference)).toMatch(/To turn Notifai off in one project while leaving other projects wired, run `notifai project disable`: nothing from that project reaches the User's devices until `notifai project enable`/)
    // Each setting's meaning lives in `notifai config explain`; harness setup
    // keeps only what the agent does with questions off.
    expect(harnessSetupReference).not.toMatch(/ask_grace_seconds|reply_window_seconds/)
    expect(loose(harnessSetupReference)).toMatch(/`ask_notifications`\) off, ask in the conversation, or in your own question form/i)
    expect(loose(harnessSetupReference)).not.toMatch(/still reach the User/i)
    const setup = loose(section('## Set Notifai up'))
    expect(setup).toMatch(/“Notifai me” or “use notifai” authorizes durable enablement for this Project; do not ask again\. Run the send\./)
    expect(setup).not.toMatch(/turns it back on: run it/i)
    // Off macOS OpenClaw has no answer continuation, so it waits in the command.
    expect(loose(harnessFile('openclaw'))).toMatch(/Off macOS, `ask` refuses: use a blocking `notifai send --reply` question/)
  })

  it('moves per-harness mechanics into progressive disclosure', () => {
    expect(skill).toContain('[Harness setup and recovery](references/harness-setup.md)')
    expect(loose(skill)).toMatch(/read it when you are\s+installing hooks or diagnosing routing/i)
    expect(harnessReference).toMatch(/exact `HERMES_SESSION_ID`/i)
    expect(harnessReference).toMatch(/`notifai hooks install --harness hermes`\s+installs and enables Notifai's native plugin/i)
    expect(harnessFile('hermes')).toMatch(/On other Hermes surfaces `ask` refuses: use a blocking\s+`notifai send --reply` question/)
    expect(harnessFile('hermes')).toMatch(/bounded system prompt section/)
    expect(harnessFile('hermes')).not.toMatch(/two system prompt sections/i)
    expect(harnessReference).toMatch(/built-in Notifai skill installer/i)
    expect(harnessReference).toMatch(/Hermes plugin does not include a copy/i)
    // The agent runs what a process can run; the human only does the human part.
    expect(harnessSetupReference).toMatch(/no scope to ask about[\s\S]{0,150}one lifecycle mechanism per harness[\s\S]{0,60}machine/i)
    expect(harnessReference).toContain('notifai init --hooks --json')
    expect(harnessReference).toContain('--skills-scope <project|global>')
    expect(harnessReference).not.toContain('--setup-scope')
    expect(harnessReference).toContain('~/.codex/hooks.json')
    expect(harnessSetupReference).toMatch(/run `notifai init --json` yourself/i)
    expect(harnessSetupReference).toMatch(/only the user can approve/i)
  })
})
