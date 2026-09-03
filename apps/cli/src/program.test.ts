import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildProgram, type ProgramRunners } from './program.js'
import type { CommandDeps } from './commands.js'
import { QUESTION_SETTLEMENT_INPUT_ENV } from './question-settlement-process.js'

/**
 * The layer these tests own is the argv boundary: what a real command line
 * turns into by the time a command implementation receives it. Collector
 * defaults, `--no-wait` disentangling, `--body-file` reading — none of that is
 * visible to the unit tests on the commands themselves, and it used to be
 * covered by nothing but reading `program.ts` with human eyes.
 */

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

function makeDeps(): CommandDeps & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = []
  const errLines: string[] = []
  return {
    io: {
      out: (line: string) => outLines.push(line),
      err: (line: string) => errLines.push(line),
      confirm: async () => false,
      openUrl: () => {},
    },
    store: {
      load: () => null,
      save: () => {},
      clear: () => {},
      describe: () => 'test credential store',
    },
    env: {},
    cwd: os.tmpdir(),
    outLines,
    errLines,
  }
}

/**
 * Parse a real command line and capture what would have been dispatched.
 * `exit` throws so post-exit code cannot run — the same property
 * `process.exit` gives production.
 */
async function parse(
  argv: string[],
  runners: Partial<ProgramRunners>,
  deps = makeDeps(),
): Promise<{ exitCode: number | undefined; deps: ReturnType<typeof makeDeps> }> {
  let exitCode: number | undefined
  const program = buildProgram(deps, {
    runners,
    exit: (code: number) => {
      exitCode = code
      throw new ExitSentinel(code)
    },
  })
  try {
    await program.parseAsync(['node', 'notifai', ...argv])
  } catch (err) {
    if (!(err instanceof ExitSentinel)) throw err
  }
  return { exitCode, deps }
}

describe('program argv parsing', () => {
  it('maps a full send command line onto sendCommand flags', async () => {
    let seen: Record<string, unknown> | undefined
    const { exitCode } = await parse(
      [
        'send',
        '--kind', 'done',
        '--title', 'Build finished',
        '--summary', 'All green.',
        '--body', 'All green.',
        '--choice', 'Ship it',
        '--choice', 'Hold',
        '--multi',
        '--reply',
        '--reply-timeout', '30',
      ],
      { send: (async (_deps, flags) => ((seen = flags as Record<string, unknown>), 0)) as ProgramRunners['send'] },
    )
    expect(exitCode).toBe(0)
    expect(seen).toMatchObject({
      kind: 'done',
      title: 'Build finished',
      summary: 'All green.',
      body: 'All green.',
      choice: ['Ship it', 'Hold'],
      multi: true,
      reply: true,
      replyTimeout: 30,
      noWait: false,
    })
  })

  it('preserves deliberate Projectless send intent at the argv boundary', async () => {
    let seen: Record<string, unknown> | undefined
    await parse(
      ['send', '--kind', 'done', '--title', 'T', '--summary', 'B', '--body', 'B', '--projectless'],
      { send: (async (_deps, flags) => ((seen = flags as Record<string, unknown>), 0)) as ProgramRunners['send'] },
    )
    expect(seen).toMatchObject({ projectless: true })
  })

  it('dispatches User-owned Project enablement commands', async () => {
    let enabled = 0
    const result = await parse(['project', 'enable'], {
      projectEnable: ((_deps) => (enabled += 1, 0)) as ProgramRunners['projectEnable'],
    })
    expect(result.exitCode).toBe(0)
    expect(enabled).toBe(1)
  })

  it('dispatches the current Agent Session rename without exposing an id override', async () => {
    let label: string | undefined
    const result = await parse(['session', 'rename', 'Hermes Support'], {
      agentSessionRename: (async (_deps, value) => ((label = value), 0)) as ProgramRunners['agentSessionRename'],
    })
    expect(result.exitCode).toBe(0)
    expect(label).toBe('Hermes Support')
  })

  it('hands the detached settlement input to the internal hook owner', async () => {
    const deps = makeDeps()
    const input = JSON.stringify({ session_id: 'session-1', cwd: '/tmp/project' })
    deps.env[QUESTION_SETTLEMENT_INPUT_ENV] = input
    let seen:
      | { event: string; input: string; harness: string | undefined }
      | undefined

    const result = await parse(
      ['hook', 'question-settlement', '--owner', 'notifai', '--harness', 'codex'],
      {
        hookRun: (async (_deps, event, readInput, harness) => {
          seen = { event, input: await readInput(), harness }
          return 0
        }) as ProgramRunners['hookRun'],
      },
      deps,
    )

    expect(result.exitCode).toBe(0)
    expect(seen).toEqual({ event: 'question-settlement', input, harness: 'codex' })
    expect(deps.env[QUESTION_SETTLEMENT_INPUT_ENV]).toBeUndefined()
  })

  it('dispatches sounds --json onto soundsCommand', async () => {
    let seen: Record<string, unknown> | undefined
    const result = await parse(['sounds', '--json'], {
      sounds: (async (_deps, flags) => ((seen = flags as Record<string, unknown>), 0)) as ProgramRunners['sounds'],
    })
    expect(result.exitCode).toBe(0)
    expect(seen).toMatchObject({ json: true })
  })

  it('passes a custom sound name through --sound', async () => {
    let seen: Record<string, unknown> | undefined
    await parse(
      ['send', '--kind', 'done', '--title', 'T', '--summary', 'B', '--body', 'B', '--sound', 'Kitchen timer'],
      { send: (async (_deps, flags) => ((seen = flags as Record<string, unknown>), 0)) as ProgramRunners['send'] },
    )
    expect(seen).toMatchObject({ sound: 'Kitchen timer' })
  })

  it('drops empty collector defaults so "not passed" stays absent', async () => {
    let seen: Record<string, unknown> | undefined
    await parse(
      ['send', '--kind', 'update', '--title', 'T', '--summary', 'B', '--body', 'B'],
      { send: (async (_deps, flags) => ((seen = flags as Record<string, unknown>), 0)) as ProgramRunners['send'] },
    )
    expect(seen).toBeDefined()
    expect(seen).not.toHaveProperty('choice')
    expect(seen).not.toHaveProperty('image')
    expect(seen).not.toHaveProperty('imageAlt')
    expect(seen).not.toHaveProperty('wait')
  })

  it('maps init --skills-scope onto the command flags', async () => {
    let seen: Record<string, unknown> | undefined
    const { exitCode } = await parse(
      ['init', '--skills', '--skills-scope', 'global', '--no-hooks'],
      { init: (async (_deps, flags) => ((seen = flags as Record<string, unknown>), 0)) as ProgramRunners['init'] },
    )
    expect(exitCode).toBe(0)
    expect(seen).toMatchObject({ skills: true, skillsScope: 'global', hooks: false })
  })

  it('has no install-scope flag on hooks install or uninstall', async () => {
    const install = await parse(['hooks', 'install', '--global'], {
      hooksInstall: (() => 0) as ProgramRunners['hooksInstall'],
    })
    expect(install.exitCode).not.toBe(0)
    const uninstall = await parse(['hooks', 'uninstall', '--global'], {
      hooksUninstall: (() => 0) as ProgramRunners['hooksUninstall'],
    })
    expect(uninstall.exitCode).not.toBe(0)
  })

  it('dispatches update --json onto the local CLI recovery', async () => {
    let seen: Record<string, unknown> | undefined
    const { exitCode } = await parse(
      ['update', '--json'],
      { update: ((_deps, flags) => ((seen = flags as Record<string, unknown>), 0)) as ProgramRunners['update'] },
    )
    expect(exitCode).toBe(0)
    expect(seen).toEqual({ json: true })
  })

  it('disentangles --no-wait and --wait from their shared commander flag', async () => {
    const capture = (sink: Record<string, unknown>[]): ProgramRunners['send'] =>
      (async (_deps, flags) => (sink.push(flags as Record<string, unknown>), 0)) as ProgramRunners['send']
    const seen: Record<string, unknown>[] = []
    await parse(['send', '--kind', 'update', '--title', 'T', '--summary', 'B', '--body', 'B', '--no-wait'], { send: capture(seen) })
    await parse(['send', '--kind', 'update', '--title', 'T', '--summary', 'B', '--body', 'B', '--wait', '5'], { send: capture(seen) })
    expect(seen[0]).toMatchObject({ noWait: true })
    expect(seen[0]).not.toHaveProperty('wait')
    expect(seen[1]).toMatchObject({ noWait: false, wait: 5 })
  })

  it('reads --body-file and refuses it alongside --body', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'notifai-program-test-'))
    const file = path.join(dir, 'body.md')
    writeFileSync(file, 'From a file.\n')
    let seen: Record<string, unknown> | undefined
    const send = (async (_deps, flags) => ((seen = flags as Record<string, unknown>), 0)) as ProgramRunners['send']

    const ok = await parse(['send', '--kind', 'update', '--title', 'T', '--summary', 'From a file.', '--body-file', file], { send })
    expect(ok.exitCode).toBe(0)
    expect(seen).toMatchObject({ body: 'From a file.\n' })
    expect(seen).not.toHaveProperty('bodyFile')

    const both = await parse(
      ['send', '--kind', 'update', '--title', 'T', '--summary', 'B', '--body', 'B', '--body-file', file],
      { send },
    )
    expect(both.exitCode).toBe(2)
    expect(both.deps.errLines.join('\n')).toContain('either --body or --body-file')

    const missing = await parse(
      ['send', '--kind', 'update', '--title', 'T', '--summary', 'Missing body.', '--body-file', path.join(dir, 'absent.md')],
      { send },
    )
    expect(missing.exitCode).toBe(2)
    expect(missing.deps.errLines.join('\n')).toContain('Could not read')
  })

  it('builds ask flags without empty collectors and passes the question through', async () => {
    let seenQuestion: string | undefined
    let seenFlags: Record<string, unknown> | undefined
    const ask = (async (_deps, question, flags) => {
      seenQuestion = question
      seenFlags = flags as Record<string, unknown>
      return 0
    }) as ProgramRunners['ask']

    await parse(
      ['ask', 'Deploy where?', '--title', 'Choose a deployment target', '--choice', 'Staging', '--choice', 'Production', '--session-label', 'release run', '--json'],
      { ask },
    )
    expect(seenQuestion).toBe('Deploy where?')
    expect(seenFlags).toEqual({
      choice: ['Staging', 'Production'],
      title: 'Choose a deployment target',
      sessionLabel: 'release run',
      json: true,
    })

    await parse(['ask', 'Free text?', '--title', 'Need a detail'], { ask })
    expect(seenFlags).toEqual({ title: 'Need a detail' })

    await parse(['ask', 'Ship now?', '--choice', 'Ship now', '--choice', 'Wait'], { ask })
    expect(seenQuestion).toBe('Ship now?')
    expect(seenFlags).toEqual({ choice: ['Ship now', 'Wait'] })
  })

  it('rejects --no-block as unknown: the flag is gone, not tombstoned', async () => {
    const { exitCode, deps } = await parse(
      ['send', '--kind', 'update', '--title', 'T', '--summary', 'B', '--body', 'B', '--no-block'],
      { send: (async () => 0) as ProgramRunners['send'] },
    )
    expect(exitCode).toBe(2)
    expect(deps.errLines).toHaveLength(0)
  })

  it('names an unknown command and exits 2', async () => {
    const { exitCode, deps } = await parse(['sendd'], {})
    expect(exitCode).toBe(2)
    expect(deps.errLines.join('\n')).toContain('Unknown command "sendd"')
    expect(deps.errLines.join('\n')).toContain('send')
  })

  it('rejects send --event now that the public event field is gone', async () => {
    const { exitCode, deps } = await parse(
      ['send', '--kind', 'done', '--title', 'T', '--body', 'B', '--event', 'tests_passed'],
      { send: (async () => 0) as ProgramRunners['send'] },
    )
    expect(exitCode).toBe(2)
    expect(deps.errLines).toHaveLength(0)
  })

  it('drops the empty --event collector for logs', async () => {
    let seen: Record<string, unknown> | undefined
    const logs = ((_deps, flags) => ((seen = flags as Record<string, unknown>), 0)) as ProgramRunners['logs']
    await parse(['logs'], { logs })
    expect(seen).not.toHaveProperty('event')
    await parse(['logs', '--event', 'send.submitted'], { logs })
    expect(seen).toMatchObject({ event: ['send.submitted'] })
  })

  it('passes close --pending without inventing a request id', async () => {
    let seenId: string | undefined
    let seenFlags: Record<string, unknown> | undefined
    const close = (async (_deps, requestId, flags) => {
      seenId = requestId
      seenFlags = flags as Record<string, unknown>
      return 0
    }) as ProgramRunners['close']

    await parse(['close', '--pending', '--json'], { close })
    expect(seenId).toBeUndefined()
    expect(seenFlags).toEqual({ pending: true, json: true })

    await parse(['close', 'req_abc'], { close })
    expect(seenId).toBe('req_abc')
    expect(seenFlags).toEqual({})
  })
})
