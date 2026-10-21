import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildProgram, type ProgramRunners } from './program.js'
import type { CommandDeps } from './commands.js'
import { QUESTION_SETTLEMENT_INPUT_ENV } from './question-settlement-process.js'
import { GROK_ATTEND_INPUT_ENV } from './grok-attendant.js'
import { SEND_WAIT_DEPRECATED } from './commands-send.js'

/**
 * The layer these tests own is the argv boundary: what a real command line
 * turns into by the time a command implementation receives it. Collector
 * defaults, `--body-file` reading — none of that is
 * visible to the unit tests on the commands themselves, and it used to be
 * covered by nothing but reading `program.ts` with human eyes.
 */

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

it('self-check advertises npm route capability without loading credentials or mutating installation state', async () => {
  const deps = makeDeps()
  deps.store.load = () => { throw new Error('self-check must not access credentials') }
  const result = await parse(['self-check', '--json'], {}, deps)
  expect(JSON.parse(result.deps.outLines.join('\n'))).toMatchObject({ capabilities: { npm_adapter_routes: 1 } })
})

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
        '--delivery-timeout', '0',
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
      deliveryTimeout: 0,
    })
    expect(seen).not.toHaveProperty('wait')
    expect(seen).not.toHaveProperty('noWait')
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

  it.each([
    ['question-settlement', 'codex', QUESTION_SETTLEMENT_INPUT_ENV],
    ['attend', 'grok', GROK_ATTEND_INPUT_ENV],
  ])('hands detached %s input to the internal hook owner', async (event, harness, inputKey) => {
    const deps = makeDeps()
    const input = JSON.stringify({ session_id: 'session-1', cwd: '/tmp/project' })
    deps.env[inputKey] = input
    let seen:
      | { event: string; input: string; harness: string | undefined }
      | undefined

    const result = await parse(
      ['hook', event, '--owner', 'notifai', '--harness', harness],
      {
        hookRun: (async (_deps, event, readInput, harness) => {
          seen = { event, input: await readInput(), harness }
          return 0
        }) as ProgramRunners['hookRun'],
      },
      deps,
    )

    expect(result.exitCode).toBe(0)
    expect(seen).toEqual({ event, input, harness })
    expect(deps.env[inputKey]).toBeUndefined()
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

  it('routes beta updates but refuses channel flags on read-only inspection', async () => {
    const update = vi.fn(() => 0)
    const beta = await parse(['update', '--channel', 'beta'], { update })
    expect(beta.exitCode).toBe(0)
    expect(update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ channel: 'beta' }))
    expect((await parse(['update', '--channel', 'preview'], { update })).exitCode).toBe(2)
    expect((await parse(['update', '--check', '--channel', 'beta'], { update })).exitCode).toBe(2)
  })

  it('maps `ask --wait` onto the waiting mode and keeps `send` to its delivery timeout', async () => {
    const ask = vi.fn(async () => 0) as unknown as ProgramRunners['ask']
    await parse(['ask', 'Ship it?', '--title', 'Release', '--wait', '--json'], { ask })
    expect(ask).toHaveBeenCalledWith(expect.anything(), 'Ship it?', { title: 'Release', wait: true, json: true })
    await parse(['ask', 'Ship it?', '--title', 'Release'], { ask })
    expect(ask).toHaveBeenLastCalledWith(expect.anything(), 'Ship it?', { title: 'Release' })
    // `send` waits only for provider outcomes. Its old names stay as hidden
    // aliases of `--delivery-timeout`, each naming the new flag once.
    const seen: Record<string, unknown>[] = []
    const send = (async (_deps, flags) => (seen.push(flags as Record<string, unknown>), 0)) as ProgramRunners['send']
    await parse(['send', '--kind', 'update', '--title', 'T', '--summary', 'B', '--body', 'B', '--delivery-timeout', '5'], { send })
    expect(seen[0]).toMatchObject({ deliveryTimeout: 5 })
    const noWait = await parse(['send', '--kind', 'update', '--title', 'T', '--summary', 'B', '--no-wait'], { send })
    expect(noWait.exitCode).toBe(0)
    expect(seen[1]).toMatchObject({ deliveryTimeout: 0 })
    expect(seen[1]).not.toHaveProperty('wait')
    expect(noWait.deps.errLines).toEqual([SEND_WAIT_DEPRECATED])
    expect((await parse(['send', '--kind', 'update', '--title', 'T', '--summary', 'B', '--wait', '7'], { send })).exitCode).toBe(0)
    expect(seen[2]).toMatchObject({ deliveryTimeout: 7 })
    // The new name wins over the old one.
    await parse(['send', '--kind', 'update', '--title', 'T', '--summary', 'B', '--wait', '7', '--delivery-timeout', '3'], { send })
    expect(seen[3]).toMatchObject({ deliveryTimeout: 3 })
    const help = buildProgram(makeDeps(), { runners: {}, exit: () => {} }).commands.find((command) => command.name() === 'send')!.helpInformation()
    expect(help).toContain('--delivery-timeout')
    for (const hidden of ['--no-wait', '--wait ']) expect(help, hidden).not.toContain(hidden)
    // `replies --wait` stays a hidden, deprecated bounded poll.
    const replies = vi.fn(async () => 0) as unknown as ProgramRunners['replies']
    expect((await parse(['replies', 'req_x', '--wait', '5'], { replies })).exitCode).toBe(0)
    expect(replies).toHaveBeenCalledWith(expect.anything(), 'req_x', { wait: 5 })
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
      ['ask', 'Deploy where?', '--title', 'Deploy target', '--choice', 'Staging', '--choice', 'Production', '--session-label', 'release run', '--json'],
      { ask },
    )
    expect(seenQuestion).toBe('Deploy where?')
    expect(seenFlags).toEqual({
      title: 'Deploy target',
      choice: ['Staging', 'Production'],
      sessionLabel: 'release run',
      json: true,
    })

    await parse(['ask', 'Free text?'], { ask })
    expect(seenFlags).toEqual({})

    await parse(['ask', 'Ship now?', '--choice', 'Ship now', '--choice', 'Wait'], { ask })
    expect(seenQuestion).toBe('Ship now?')
    expect(seenFlags).toEqual({ choice: ['Ship now', 'Wait'] })

    // A description records the choice it follows, in command-line order.
    await parse([
      'ask', 'Ship now?',
      '--choice', 'Ship now', '--choice-description', 'Two minutes of downtime.',
      '--choice', 'Wait',
      '--choice', 'Hold', '--choice-description', 'Nothing ships today.',
      '--recommended', 'Wait',
    ], { ask })
    expect(seenFlags).toEqual({
      choice: ['Ship now', 'Wait', 'Hold'],
      choiceDescription: [{ after: 1, text: 'Two minutes of downtime.' }, { after: 3, text: 'Nothing ships today.' }],
      recommended: ['Wait'],
    })
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

it('routes read-only update inspection separately from package installation', async () => {
  const update = vi.fn(() => 0)
  const updateCheck = vi.fn(async () => 0)
  const result = await parse(['update', '--check', '--json', '--from', '11.0.6'], { update, updateCheck })
  expect(result.exitCode).toBe(0)
  expect(update).not.toHaveBeenCalled()
  expect(updateCheck).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ check: true, json: true, from: '11.0.6' }))
})

it('resumes integration without reinstalling or changing channel', async () => {
  const update = vi.fn(() => 0)
  const updateResume = vi.fn(async () => 0)
  expect((await parse(['update', '--resume', '--json', '--from', '11.0.6'], { update, updateResume })).exitCode).toBe(0)
  expect(update).not.toHaveBeenCalled()
  expect(updateResume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resume: true, from: '11.0.6' }))
  expect((await parse(['update', '--resume', '--channel', 'stable'], { update, updateResume })).exitCode).toBe(2)
  expect(updateResume).toHaveBeenCalledTimes(1)
})


it('awaits native rollback and rejects ambiguous lifecycle operations', async () => {
  const update = vi.fn(async () => 1)
  const result = await parse(['update', '--rollback', '--json'], { update })
  expect(result.exitCode).toBe(1)
  expect(update).toHaveBeenCalledWith(expect.anything(), { rollback: true, json: true })
  for (const args of [['--rollback', '--channel', 'stable'], ['--repair', '--check'], ['--abandon', '--resume'], ['--allow-downgrade']]) {
    update.mockClear()
    expect((await parse(['update', ...args], { update })).exitCode).toBe(2)
    expect(update).not.toHaveBeenCalled()
  }
})


it('parses native offline installation and explicit setup skips without treating the version as CLI help', async () => {
  let flags: unknown
  const result = await parse(['install', '--directory', '/candidate', '--inventory', '/signed.json', '--source', 'npm',
    '--version', '1.0.0', '--channel', 'stable', '--no-init', '--no-path', '--json'], {
    install: async (_deps, input) => { flags = input; return 0 },
  })
  expect(result.exitCode).toBe(0)
  expect(flags).toMatchObject({ directory: '/candidate', inventory: '/signed.json', source: 'npm', version: '1.0.0',
    channel: 'stable', init: false, path: false, json: true })
})

describe('repository config Notifai no longer reads', () => {
  const removed = 'Repository-committed guidance and config were removed; use `--local` for this project.'

  it.each([
    [['config', 'set', 'sound', 'ping', '--project', '--yes'], 'configSet'],
    [['config', 'unset', 'sound', '--project', '--yes'], 'configUnset'],
    [['guidance', 'set', 'titles', 'Short.', '--project', '--yes'], 'guidanceSet'],
    [['guidance', 'unset', 'titles', '--project', '--yes'], 'guidanceUnset'],
  ] as const)('refuses %j with exit 2 and writes nothing', async (argv, runner) => {
    const spy = vi.fn(async () => 0)
    const result = await parse([...argv], { [runner]: spy })
    expect(result.exitCode).toBe(2)
    expect(result.deps.errLines).toEqual([removed])
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps --project out of help', () => {
    const program = buildProgram(makeDeps())
    for (const [group, name] of [['config', 'set'], ['config', 'unset'], ['guidance', 'set'], ['guidance', 'unset']]) {
      const command = program.commands.find(cmd => cmd.name() === group)!.commands.find(cmd => cmd.name() === name)!
      expect(command.helpInformation()).not.toContain('--project')
    }
  })

  it('names the files once per repository, for every worktree and folder of it, and never from a hook', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-repo-config-'))
    const repo = path.join(root, 'repo')
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    execFileSync('git', ['init', '-q', repo])
    mkdirSync(path.join(repo, '.notifai', 'guidance'), { recursive: true })
    writeFileSync(path.join(repo, '.notifai', 'guidance', 'titles.md'), 'House rules.')
    const run = async (argv: string[], cwd: string) => {
      const deps = makeDeps()
      deps.env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
      deps.cwd = cwd
      return (await parse(argv, { guidanceShow: async () => 0, configShow: () => 0, hookRun: async () => 0 }, deps)).deps.errLines
    }
    expect(await run(['hook', 'session-start'], repo)).toEqual([])
    const first = await run(['guidance', 'show'], path.join(repo, 'src'))
    expect(first).toHaveLength(2)
    expect(first[0]).toContain('no longer reads')
    expect(first[1]).toContain('notifai config set <key> <value> --local')
    expect(await run(['guidance', 'show'], repo)).toEqual([])
    expect(await run(['config', 'show'], path.join(repo, 'src'))).toEqual([])
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'init'])
    const linked = path.join(root, 'linked')
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', linked])
    mkdirSync(path.join(linked, '.notifai'), { recursive: true })
    writeFileSync(path.join(linked, '.notifai', 'config.toml'), 'sound = "ping"\n')
    expect(await run(['guidance', 'show'], linked)).toEqual([])
    const plain = path.join(root, 'plain')
    mkdirSync(plain)
    execFileSync('git', ['init', '-q', plain])
    mkdirSync(path.join(plain, '.notifai'))
    writeFileSync(path.join(plain, '.notifai', 'config.toml'), '')
    expect(await run(['guidance', 'show'], plain)).toHaveLength(2)
  })
})
