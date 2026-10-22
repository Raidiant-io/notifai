import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_ALLOWED_COMMANDS,
  CODEX_COMMANDS_PROSE,
  CODEX_COMMAND_RULES_HEADER,
  CODEX_RULE_CHECK_COMMAND,
  assessCodexCommandRules,
  codexCommandReadiness,
  codexCommandRulesFile,
  codexLayerRuleFiles,
  inspectCodexCommandRules,
  installCodexCommandRules,
  parseExecpolicyReport,
  removeCodexCommandRules,
  renderCodexCommandRules,
  type CheckCodexCommandRules,
} from './codex-command-rules.js'

const skill = readFileSync(new URL('../../../skills/notifai/SKILL.md', import.meta.url), 'utf8')
const references = ['harness-codex', 'harness-setup', 'send-details', 'writing-examples', 'diagnostics', 'updates', 'installation', 'npm-migration', 'hermes-publication-recovery']
  .map((name) => readFileSync(new URL(`../../../skills/notifai/references/${name}.md`, import.meta.url), 'utf8'))
  .join('\n')

function freshEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-rules-'))
  return { HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, '.codex') }
}

/**
 * The commands the skill teaches, as the argument lists a plain-word shell
 * script splits into. Placeholders such as `<question_id>` are words, not
 * redirection. Any other shell feature is a defect in the example itself,
 * because Codex cannot split such a script and no rule matches it.
 */
function skillCommandExamples(source: string): string[][] {
  const examples: string[][] = []
  for (const block of source.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const script = block[1]!.replace(/\\\n\s*/g, ' ')
    // A single-quoted value may hold real line breaks; only a line break
    // outside quotes ends a command.
    for (const line of script.match(/(?:'[^']*'|[^'\n])+/g) ?? []) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('notifai ')) continue
      // Quoted text is one word to a shell; operators matter only outside it.
      const unquoted = trimmed.replace(/'[^']*'|<[^<>\s]+>/g, 'q')
      // Every text value is single-quoted, so the shell expands nothing in it.
      expect(unquoted, trimmed).not.toContain('"')
      expect(unquoted, trimmed).not.toMatch(/<<|\$\(|`|(^|\s)[A-Z_]+=|\||&&|;|>|</)
      examples.push(shellWords(trimmed))
    }
  }
  return examples
}

function shellWords(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let pending = false
  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      pending = true
    } else if (char === '"' || char === "'") {
      quote = char
      pending = true
    } else if (/\s/.test(char)) {
      if (pending) words.push(current)
      current = ''
      pending = false
    } else {
      current += char
      pending = true
    }
  }
  if (pending) words.push(current)
  return words
}

function expectedDecision(words: readonly string[]): 'allow' | 'prompt' | 'none' {
  const [, command, sub] = words
  if (command === 'guidance') return sub === 'set' || sub === 'unset' ? 'prompt' : 'allow'
  if (command === 'session') return sub === 'rename' ? 'allow' : 'none'
  return CODEX_ALLOWED_COMMANDS.includes(command ?? '') ? 'allow' : 'none'
}

function codexAvailable(): boolean {
  try {
    execFileSync('codex', ['execpolicy', '--help'], { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

function execpolicy(files: readonly string[], command: readonly string[]): { decision?: string; matchedRules: unknown[] } {
  const stdout = execFileSync('codex', ['execpolicy', 'check', ...files.flatMap((file) => ['--rules', file]), '--', ...command], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  return JSON.parse(stdout) as { decision?: string; matchedRules: unknown[] }
}

describe('Codex command rules file', () => {
  it('allows sending, asking, reading and acknowledging, and nothing that changes setup', () => {
    for (const command of ['send', 'ask', 'receive', 'acknowledge', 'status', 'replies', 'close']) {
      expect(CODEX_ALLOWED_COMMANDS).toContain(command)
    }
    const body = renderCodexCommandRules()
    for (const command of ['init', 'config', 'logout', 'auth', 'hooks', 'logs', 'update', 'project', 'doctor', 'uninstall', 'install']) {
      expect(body).not.toMatch(new RegExp(`"${command}"`))
    }
    expect(body.startsWith(`${CODEX_COMMAND_RULES_HEADER}\n`)).toBe(true)
    expect(body).toContain('pattern = ["notifai", "guidance", ["set", "unset"]]')
    expect(body).toContain('decision = "prompt"')
    expect(body).toContain('pattern = ["notifai", "session", "rename"]')
    expect(body.endsWith('\n')).toBe(true)
  })

  it('lives under rules/ in the running Codex home', () => {
    expect(codexCommandRulesFile({ HOME: '/user', CODEX_HOME: '/managed/codex' })).toBe('/managed/codex/rules/notifai.rules')
    expect(codexCommandRulesFile({ HOME: '/user' }, 'darwin')).toBe('/user/.codex/rules/notifai.rules')
  })

  it('writes, recognises, refreshes and removes only its own file', () => {
    const env = freshEnv()
    const file = codexCommandRulesFile(env)
    expect(inspectCodexCommandRules(env)).toEqual({ file, condition: 'missing', writtenAt: null })
    expect(removeCodexCommandRules(env)).toBe('absent')

    expect(installCodexCommandRules(env)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(renderCodexCommandRules())
    expect(inspectCodexCommandRules(env)).toMatchObject({ file, condition: 'current' })
    expect(inspectCodexCommandRules(env).writtenAt).toBeTypeOf('number')
    expect(installCodexCommandRules(env)).toBe(false)

    writeFileSync(file, `${CODEX_COMMAND_RULES_HEADER}\nprefix_rule(pattern = ["notifai", "send"])\n`)
    expect(inspectCodexCommandRules(env).condition).toBe('outdated')
    expect(installCodexCommandRules(env)).toBe(true)
    expect(inspectCodexCommandRules(env).condition).toBe('current')

    expect(removeCodexCommandRules(env)).toBe('removed')
    expect(inspectCodexCommandRules(env).condition).toBe('missing')
  })

  it('never replaces or deletes a file Notifai did not write', () => {
    const env = freshEnv()
    const file = codexCommandRulesFile(env)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'prefix_rule(pattern = ["notifai"], decision = "forbidden")\n')
    expect(inspectCodexCommandRules(env).condition).toBe('foreign')
    expect(() => installCodexCommandRules(env)).toThrow(/did not write it/)
    expect(removeCodexCommandRules(env)).toBe('foreign')
    expect(readFileSync(file, 'utf8')).toContain('forbidden')

    const linked = freshEnv()
    const link = codexCommandRulesFile(linked)
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(file, link)
    expect(inspectCodexCommandRules(linked).condition).toBe('foreign')
    expect(removeCodexCommandRules(linked)).toBe('foreign')
  })

  it('lists the sibling rule files Codex loads from the same layer', () => {
    const env = freshEnv()
    installCodexCommandRules(env)
    const dir = path.dirname(codexCommandRulesFile(env))
    writeFileSync(path.join(dir, 'default.rules'), '')
    writeFileSync(path.join(dir, 'notes.txt'), '')
    expect(codexLayerRuleFiles(env)).toEqual({
      ours: codexCommandRulesFile(env),
      siblings: [path.join(dir, 'default.rules')],
    })
  })

  it('reads execpolicy output into a decision', () => {
    expect(parseExecpolicyReport('{"matchedRules":[]}')).toEqual({ decision: 'none', justifications: [] })
    expect(parseExecpolicyReport('{"matchedRules":[{"prefixRuleMatch":{"decision":"allow","justification":"x"}}],"decision":"allow"}'))
      .toEqual({ decision: 'allow', justifications: ['x'] })
    expect(parseExecpolicyReport('nope')).toMatchObject({ error: expect.stringContaining('unreadable') })
    expect(parseExecpolicyReport('{"decision":"maybe"}')).toMatchObject({ error: expect.stringContaining('maybe') })
  })
})

describe('Codex command approval readiness', () => {
  const current = { file: '/home/.codex/rules/notifai.rules', condition: 'current' as const, writtenAt: 2_000 }
  const allow = { decision: 'allow' as const, justifications: ['Notifai notifications and answers'] }

  it('reports the missing rule as an optional gap init can close', () => {
    expect(codexCommandReadiness({ inspection: { ...current, condition: 'missing', writtenAt: null } })).toMatchObject({
      id: 'codex-commands',
      status: 'optional-gap',
      harnesses: ['codex'],
      remedy: { by: 'cli', command: 'notifai init --codex-commands' },
    })
  })

  it('asks for a refresh of an older build\'s file and leaves a foreign file to the User', () => {
    expect(codexCommandReadiness({ inspection: { ...current, condition: 'outdated' } })).toMatchObject({
      status: 'optional-gap',
      remedy: { by: 'cli', command: 'notifai init --codex-commands' },
    })
    expect(codexCommandReadiness({ inspection: { ...current, condition: 'foreign' } })).toMatchObject({
      status: 'optional-gap',
      remedy: { by: 'user-here', command: 'notifai init --codex-commands' },
    })
  })

  it('names every command the rule allows when it reports the rule in place', () => {
    expect(CODEX_COMMANDS_PROSE).toBe('send, ask, receive, acknowledge, status, replies, close, guidance and session rename')
    expect(codexCommandReadiness({ inspection: current, ownCheck: allow, layerCheck: allow }).detail).toContain(CODEX_COMMANDS_PROSE)
    expect(codexCommandReadiness({ inspection: current, ownCheck: null }).detail).toContain(CODEX_COMMANDS_PROSE)
  })

  it('is ready once the rule is written, verified or not', () => {
    expect(codexCommandReadiness({ inspection: current, ownCheck: allow, layerCheck: allow })).toMatchObject({
      status: 'ready',
      technical: { verified: true },
    })
    expect(codexCommandReadiness({ inspection: current, ownCheck: null })).toMatchObject({
      status: 'ready',
      technical: { verified: false },
    })
  })

  it('turns a failing rule check into per-command approval, never readiness', () => {
    const rejected = codexCommandReadiness({ inspection: current, ownCheck: { error: 'failed to parse policy' } })
    expect(rejected).toMatchObject({ status: 'optional-gap', technical: { check_error: 'failed to parse policy' } })
    expect(rejected.detail).toMatch(/approve Notifai commands when Codex asks/)
    expect(rejected.remedy).toBeUndefined()
    const unmatched = codexCommandReadiness({ inspection: current, ownCheck: { decision: 'none', justifications: [] } })
    expect(unmatched).toMatchObject({ status: 'optional-gap', technical: { decision: 'none' } })
  })

  it('reports a forbidden or prompting layer rule as the organization\'s choice', () => {
    const forbidden = codexCommandReadiness({
      inspection: current,
      ownCheck: allow,
      layerCheck: { decision: 'forbidden', justifications: ['Notifai notifications and answers', 'Use the approved notifier'] },
    })
    expect(forbidden).toMatchObject({ status: 'optional-gap', technical: { layer_decision: 'forbidden' } })
    expect(forbidden.detail).toMatch(/blocks Notifai commands outside the sandbox \(Use the approved notifier\); hooks keep working/)
    expect(codexCommandReadiness({ inspection: current, ownCheck: allow, layerCheck: { decision: 'prompt', justifications: [] } }))
      .toMatchObject({ status: 'optional-gap', technical: { layer_decision: 'prompt' } })
  })

  it('tells a session that predates the rule to approve per command, without ending it', () => {
    const stale = codexCommandReadiness({ inspection: current, ownCheck: allow, layerCheck: allow, sessionStartedAt: 1_000 })
    expect(stale).toMatchObject({ status: 'optional-gap', technical: { session_predates_rule: true } })
    expect(stale.detail).toMatch(/loads rules only at startup/)
    expect(stale.detail).toMatch(/new Codex sessions will not ask/)
    expect(stale.remedy).toBeUndefined()
    expect(codexCommandReadiness({ inspection: current, ownCheck: allow, layerCheck: allow, sessionStartedAt: 3_000 }).status).toBe('ready')
    expect(codexCommandReadiness({ inspection: current, ownCheck: allow, layerCheck: allow, sessionStartedAt: null }).status).toBe('ready')
  })

  it('assesses the written file with the layer\'s other rules, ignoring a sibling Codex cannot parse', async () => {
    const env = freshEnv()
    installCodexCommandRules(env)
    const dir = path.dirname(codexCommandRulesFile(env))
    writeFileSync(path.join(dir, 'default.rules'), 'broken(')
    const calls: string[][] = []
    const check: CheckCodexCommandRules = async (_env, files, command) => {
      calls.push([...files])
      expect(command).toEqual(CODEX_RULE_CHECK_COMMAND)
      return files.length === 1 ? allow : { error: 'failed to parse policy' }
    }
    expect(await assessCodexCommandRules(env, { check })).toMatchObject({ status: 'ready', technical: { verified: true } })
    expect(calls).toEqual([[codexCommandRulesFile(env)], [codexCommandRulesFile(env), path.join(dir, 'default.rules')]])

    const forbidding: CheckCodexCommandRules = async (_env, files) =>
      files.length === 1 ? allow : { decision: 'forbidden', justifications: ['blocked'] }
    expect(await assessCodexCommandRules(env, { check: forbidding })).toMatchObject({ technical: { layer_decision: 'forbidden' } })

    const written = new Date(Date.now() - 60_000)
    utimesSync(codexCommandRulesFile(env), written, written)
    expect(await assessCodexCommandRules(env, { check, sessionStartedAt: written.getTime() - 1 }))
      .toMatchObject({ status: 'optional-gap', technical: { session_predates_rule: true } })
    expect(await assessCodexCommandRules(env, { check: async () => null })).toMatchObject({ status: 'ready', technical: { verified: false } })
  })

  it('reports the file states before any check runs', async () => {
    const env = freshEnv()
    const check: CheckCodexCommandRules = async () => { throw new Error('must not run') }
    expect(await assessCodexCommandRules(env, { check })).toMatchObject({ status: 'optional-gap', technical: { condition: 'missing' } })
  })
})

describe('skill examples under the Codex rule', () => {
  const examples = skillCommandExamples(`${skill}\n${references}`)

  it('are plain argument lists that name notifai directly', () => {
    expect(examples.length).toBeGreaterThan(8)
    for (const words of examples) expect(words[0]).toBe('notifai')
    expect(examples.map((words) => words[1])).toEqual(expect.arrayContaining(['send', 'ask', 'status', 'replies', 'acknowledge']))
  })

  const live = codexAvailable() ? it : it.skip

  live('match the installed Codex exactly as the rule intends', () => {
    const env = freshEnv()
    installCodexCommandRules(env)
    const { ours } = codexLayerRuleFiles(env)
    for (const words of examples) {
      const report = execpolicy([ours], words)
      expect({ command: words.join(' '), decision: report.decision ?? 'none' })
        .toEqual({ command: words.join(' '), decision: expectedDecision(words) })
    }
    expect(execpolicy([ours], CODEX_RULE_CHECK_COMMAND).decision).toBe('allow')
  })

  live('leave shell-wrapped, path-addressed and setup commands unmatched', () => {
    const env = freshEnv()
    installCodexCommandRules(env)
    const { ours } = codexLayerRuleFiles(env)
    const unmatched: string[][] = [
      ['bash', '-lc', 'notifai send --kind done --title A --summary B --body-file - <<EOF\nhello\nEOF'],
      ['bash', '-lc', 'notifai send --kind done --title "$(date)" --summary B'],
      ['bash', '-lc', 'notifai replies --pending --json > out.json'],
      ['/usr/local/bin/notifai', 'send', '--kind', 'done', '--title', 'A', '--summary', 'B'],
      ['node', 'dist/main.js', 'send', '--kind', 'done', '--title', 'A', '--summary', 'B'],
      ['notifai', 'init', '--hooks', '--json'],
      ['notifai', 'config', 'set', 'ask_notifications', 'false'],
      ['notifai', 'hooks', 'uninstall', '--harness', 'codex'],
      ['notifai', 'update'],
    ]
    for (const words of unmatched) {
      expect({ command: words.join(' '), matched: execpolicy([ours], words).matchedRules.length }).toEqual({ command: words.join(' '), matched: 0 })
    }
  })

  live('yield to a forbidden rule in the same layer', () => {
    const env = freshEnv()
    installCodexCommandRules(env)
    const { ours } = codexLayerRuleFiles(env)
    const managed = path.join(path.dirname(ours), 'default.rules')
    writeFileSync(managed, 'prefix_rule(pattern = ["notifai"], decision = "forbidden", justification = "Use the approved notifier")\n')
    expect(execpolicy([ours, managed], CODEX_RULE_CHECK_COMMAND).decision).toBe('forbidden')
    expect(execpolicy([ours], CODEX_RULE_CHECK_COMMAND).decision).toBe('allow')
  })
})
