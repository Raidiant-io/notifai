import { execFileSync } from 'node:child_process'
import { mkdirSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe,expect,it } from 'vitest'
import { createHash } from 'node:crypto'
import {
CODEX_COMMAND_RULES_HEADER,
CODEX_PROGRAM_NAMES,
CODEX_RULE_CHECK_COMMAND,
codexCommandReadiness,
codexCommandRulesFile,
codexLayerRuleFiles,
inspectCodexCommandRules,
installCodexCommandRules,
removeCodexCommandRules,
renderCodexCommandRules,
SHIPPED_CODEX_RULES_SHA256,
upgradeCodexCommandRules
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
    // Literal quoted pieces may hold real line breaks and concatenate;
    // only an unquoted line break ends a command.
    for (const line of script.match(/(?:'[^']*'|"[^"]*"|[^'"\n])+/g) ?? []) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('notifai ')) continue
      // Quoted text is one word to a shell; operators matter only outside it.
      const unquoted = trimmed.replace(/'[^']*'|"[^"$`\\]*"|<[^<>\s]+>/g, 'q')
      // Every quoted piece is literal, including a double-quoted apostrophe.
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

/** Every rules file an earlier Notifai wrote, byte for byte. */
const SHIPPED_RULES_FILES = ['2026-10-19', '2026-10-26']
  .map((date) => readFileSync(new URL(`./fixtures/codex-notifai-rules-${date}.rules`, import.meta.url), 'utf8'))

/** A shipped file with a rule the User added beneath Notifai's header. */
const USER_EDITED_RULES_FILE = `${SHIPPED_RULES_FILES[1]}prefix_rule(pattern = ["notifai", "logout"], decision = "forbidden", justification = "Mine")\n`

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
  it('allows every Notifai command, by name or as a Windows shim, and prompts for none', () => {
    const body = renderCodexCommandRules()
    expect(body.startsWith(`${CODEX_COMMAND_RULES_HEADER}\n`)).toBe(true)
    expect(CODEX_PROGRAM_NAMES).toEqual(['notifai', 'notifai.cmd', 'notifai.ps1', 'notifai.exe'])
    expect(body).toContain('pattern = [["notifai", "notifai.cmd", "notifai.ps1", "notifai.exe"]]')
    expect(body.match(/prefix_rule\(/g)).toHaveLength(1)
    expect(body).not.toContain('"prompt"')
    expect(body.endsWith('\n')).toBe(true)
  })

  it('knows every file an earlier Notifai wrote, and never the current one, as shipped', () => {
    expect(SHIPPED_RULES_FILES.map((text) => createHash('sha256').update(text).digest('hex'))).toEqual(SHIPPED_CODEX_RULES_SHA256)
    expect(SHIPPED_CODEX_RULES_SHA256).not.toContain(createHash('sha256').update(renderCodexCommandRules()).digest('hex'))
    for (const text of SHIPPED_RULES_FILES) expect(text.startsWith(`${CODEX_COMMAND_RULES_HEADER}\n`)).toBe(true)
  })

  it('leaves a file the User edited under Notifai\'s header to setup, which only an explicit run rewrites', () => {
    const env = freshEnv()
    const file = codexCommandRulesFile(env)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, USER_EDITED_RULES_FILE)
    expect(inspectCodexCommandRules(env).condition).toBe('edited')
    expect(upgradeCodexCommandRules(env)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(USER_EDITED_RULES_FILE)
    expect(codexCommandReadiness({ inspection: inspectCodexCommandRules(env) })).toMatchObject({
      status: 'optional-gap', remedy: { by: 'cli', command: 'notifai init --codex-commands' },
    })
    expect(installCodexCommandRules(env)).toBe(true)
    expect(inspectCodexCommandRules(env).condition).toBe('current')
  })

  it.each(SHIPPED_RULES_FILES.map((text, index) => [index, text]))('widens shipped file %i in place and never creates or touches any other', (_index, shipped) => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const env = freshEnv()
      const file = codexCommandRulesFile(env, platform)
      expect(upgradeCodexCommandRules(env, platform)).toBe(false)
      expect(inspectCodexCommandRules(env, platform).condition).toBe('missing')
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, shipped)
      expect(inspectCodexCommandRules(env, platform).condition).toBe('outdated')
      expect(upgradeCodexCommandRules(env, platform)).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe(renderCodexCommandRules())
      expect(inspectCodexCommandRules(env, platform).condition).toBe('current')
      expect(upgradeCodexCommandRules(env, platform)).toBe(false)
      const sibling = path.join(path.dirname(file), 'default.rules')
      writeFileSync(sibling, 'prefix_rule(pattern = ["git"], decision = "allow")\n')
      expect(removeCodexCommandRules(env, platform)).toBe('removed')
      expect(readFileSync(sibling, 'utf8')).toContain('"git"')
    }
  })

  it('keeps the rules in the Codex home on Windows, CODEX_HOME first', () => {
    const profile = String.raw`C:\Users\ada`
    // Joined with the host's separator here; Windows itself joins with backslashes.
    expect(path.win32.normalize(codexCommandRulesFile({ USERPROFILE: profile }, 'win32'))).toBe(path.win32.join(profile, '.codex', 'rules', 'notifai.rules'))
    const home = String.raw`D:\codex-work`
    expect(path.win32.normalize(codexCommandRulesFile({ USERPROFILE: profile, CODEX_HOME: home }, 'win32'))).toBe(path.win32.join(home, 'rules', 'notifai.rules'))
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
})

describe('Codex command approval readiness', () => {
  const current = { file: '/home/.codex/rules/notifai.rules', condition: 'current' as const, writtenAt: 2_000 }

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
        .toEqual({ command: words.join(' '), decision: 'allow' })
    }
    expect(execpolicy([ours], CODEX_RULE_CHECK_COMMAND).decision).toBe('allow')
  })

  live('leave shell-wrapped, path-addressed and wrapper-run commands unmatched', () => {
    const env = freshEnv()
    installCodexCommandRules(env)
    const { ours } = codexLayerRuleFiles(env)
    const unmatched: string[][] = [
      ['bash', '-lc', 'notifai send --kind done --title A --summary B --body-file - <<EOF\nhello\nEOF'],
      ['bash', '-lc', 'notifai send --kind done --title "$(date)" --summary B'],
      ['bash', '-lc', 'notifai replies --pending --json > out.json'],
      ['/usr/local/bin/notifai', 'send', '--kind', 'done', '--title', 'A', '--summary', 'B'],
      ['node', 'dist/main.js', 'send', '--kind', 'done', '--title', 'A', '--summary', 'B'],
      ['npx', 'notifai', 'send', '--kind', 'done', '--title', 'A', '--summary', 'B'],
      [String.raw`C:\Program Files\Notifai\notifai.exe`, 'send', '--kind', 'done', '--title', 'A', '--summary', 'B'],
    ]
    for (const words of unmatched) {
      expect({ command: words.join(' '), matched: execpolicy([ours], words).matchedRules.length }).toEqual({ command: words.join(' '), matched: 0 })
    }
  })

  live('allow every subcommand, and the Windows shims and executable PowerShell resolves notifai to', () => {
    const env = freshEnv()
    installCodexCommandRules(env)
    const { ours } = codexLayerRuleFiles(env)
    const allowed: string[][] = [
      ['notifai'],
      ['notifai', 'session', 'status', '--json'],
      ['notifai', 'guidance', 'set', 'when-to-notify', 'Only when blocked', '--local', '--yes'],
      ['notifai', 'config', 'set', 'ask_notifications', 'false'],
      ['notifai', 'hooks', 'uninstall', '--harness', 'codex'],
      ['notifai', 'update'],
      ['notifai', 'logout'],
      ...CODEX_PROGRAM_NAMES.map((name) => [name, 'send', '--kind', 'done', '--title', "It's ready", '--summary', 'B']),
    ]
    for (const words of allowed) {
      expect({ command: words.join(' '), decision: execpolicy([ours], words).decision ?? 'none' }).toEqual({ command: words.join(' '), decision: 'allow' })
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
