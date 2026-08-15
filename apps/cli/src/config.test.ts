import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig, personalProjectConfigPath, sessionConfigPath } from './config.js'
import { buildDraft } from './send.js'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'notifai-cli-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function setup(options: {
  globalToml?: string
  projectToml?: string
  projectLocalToml?: string
  sessionToml?: string
  sessionId?: string
}) {
  const home = path.join(tmp, `case-${Math.random().toString(36).slice(2)}`)
  const configDir = path.join(home, 'notifai')
  mkdirSync(configDir, { recursive: true })
  if (options.globalToml !== undefined) {
    writeFileSync(path.join(configDir, 'config.toml'), options.globalToml)
  }
  const project = path.join(home, 'repo', 'nested')
  mkdirSync(project, { recursive: true })
  const projectDir = path.join(home, 'repo', '.notifai')
  if (options.projectToml !== undefined) {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(projectDir, 'config.toml'), options.projectToml)
  }
  if (options.projectLocalToml !== undefined) {
    const localFile = personalProjectConfigPath(project, { XDG_CONFIG_HOME: home })
    mkdirSync(path.dirname(localFile), { recursive: true })
    writeFileSync(localFile, options.projectLocalToml)
  }
  const state = path.join(home, 'state')
  const env = { XDG_CONFIG_HOME: home, XDG_STATE_HOME: state } as NodeJS.ProcessEnv
  if (options.sessionToml !== undefined) {
    const file = sessionConfigPath(options.sessionId ?? 'sess', env)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, options.sessionToml)
  }
  return { env, cwd: project }
}

describe('harness config layers', () => {
  it('orders session over project-local over project over global', () => {
    const { env, cwd } = setup({
      globalToml: 'ask_grace_seconds = 10\n',
      projectToml: 'ask_grace_seconds = 20\n',
      projectLocalToml: 'ask_grace_seconds = 30\n',
      sessionToml: 'ask_grace_seconds = 40\n',
      sessionId: 'abc',
    })
    expect(loadConfig({ cwd, env, sessionId: 'abc' }).ask_grace_seconds).toMatchObject({
      value: 40,
      source: expect.stringMatching(/^session:/),
    })
    // Same files, different session: the session layer simply does not apply.
    expect(loadConfig({ cwd, env, sessionId: 'other' }).ask_grace_seconds).toMatchObject({
      value: 30,
      source: expect.stringMatching(/^project-local:/),
    })
    expect(loadConfig({ cwd, env }).ask_grace_seconds.value).toBe(30)
  })

  it('keeps a personal toggle out of the committed project file', () => {
    const { env, cwd } = setup({
      projectToml: 'ask_notifications = true\n',
      projectLocalToml: 'ask_notifications = false\n',
    })
    const config = loadConfig({ cwd, env })
    expect(config.ask_notifications.value).toBe(false)
    expect(config.ask_notifications.source).toMatch(/\/projects\/[0-9a-f]{32}\.toml$/)
  })

  it('ignores an in-tree config.local.toml leftover', () => {
    const { env, cwd } = setup({ projectToml: 'ask_notifications = true\n' })
    mkdirSync(path.join(cwd, '..', '.notifai'), { recursive: true })
    writeFileSync(path.join(cwd, '..', '.notifai', 'config.local.toml'), 'ask_notifications = false\n')
    expect(loadConfig({ cwd, env }).ask_notifications).toEqual({ value: true, source: expect.stringMatching(/^project:/) })
  })

  it('takes the service origin from NOTIFAI_BASE_URL, not from a config file', () => {
    const { env, cwd } = setup({
      projectToml: 'base_url = "https://attacker.example"\n',
    })
    expect(loadConfig({ cwd, env }).base_url).toEqual({
      value: 'https://notifai.fly.dev',
      source: 'default',
    })
    expect(
      loadConfig({ cwd, env: { ...env, NOTIFAI_BASE_URL: 'https://selfhost.example' } }).base_url,
    ).toEqual({ value: 'https://selfhost.example', source: 'env' })
    expect(loadConfig({ cwd, env, flags: { base_url: 'https://flag.example' } }).base_url).toEqual({
      value: 'https://flag.example',
      source: 'flag',
    })
  })

  it('uses NOTIFAI_SESSION_ID for the session layer and ignores the deleted env name', () => {
    const { env, cwd } = setup({
      sessionToml: 'ask_grace_seconds = 45\n',
      sessionId: 'exact-session',
    })
    expect(
      loadConfig({
        cwd,
        env: { ...env, NOTIFAI_SESSION_ID: 'exact-session' },
      }).ask_grace_seconds.value,
    ).toBe(45)
    expect(
      loadConfig({
        cwd,
        env: { ...env, NOTIFAI_SESSION: 'exact-session' },
      }).ask_grace_seconds.value,
    ).toBe(0)
  })

  it('keeps hostile or colliding session ids inside their own file', () => {
    const { env, cwd } = setup({
      sessionToml: 'ask_grace_seconds = 99\n',
      sessionId: '../../etc/passwd',
    })
    // The id round-trips to its own state, and nothing escapes the directory.
    expect(loadConfig({ cwd, env, sessionId: '../../etc/passwd' }).ask_grace_seconds.value).toBe(99)
    expect(sessionConfigPath('../../etc/passwd', env)).toContain('/notifai/sessions/')
    expect(sessionConfigPath('../../etc/passwd', env)).not.toContain('..')
    // Ids that a sanitiser would have collapsed together must stay distinct:
    // sharing a file meant sharing presence and pending questions.
    expect(sessionConfigPath('a/b', env)).not.toBe(sessionConfigPath('a?b', env))
    expect(loadConfig({ cwd, env, sessionId: 'a/b' }).ask_grace_seconds.value).toBe(0)
  })

  it('defaults question routing to on and reaching the user straight away', () => {
    const { env, cwd } = setup({})
    const config = loadConfig({ cwd, env })
    expect(config.ask_notifications.value).toBe(true)
    // Nothing here asks where the user is standing. A question goes out when
    // the turn ends unless they choose a terminal-first window.
    expect(config.ask_grace_seconds).toEqual({ value: 0, source: 'default' })
  })

  it('bounds the terminal-first window so a reply window always survives it', () => {
    // Config is readable from a repository, so an unbounded grace is hostile
    // input: it would eat the waiter's whole ceiling and leave no window the
    // server would accept an answer into.
    const { env, cwd } = setup({ globalToml: 'ask_grace_seconds = 100000\n' })
    expect(loadConfig({ cwd, env }).ask_grace_seconds.value).toBe(360)
  })
})

describe('config precedence', () => {
  it('defaults apply with provenance', () => {
    const { env, cwd } = setup({})
    const config = loadConfig({ cwd, env })
    expect(config.wait_seconds.value).toBe(10)
    expect(config.wait_seconds.source).toBe('default')
    expect(config.ttl_seconds.value).toBe(86400)
  })

  it('project config (found by parent walk) beats machine-global', () => {
    const { env, cwd } = setup({
      globalToml: 'wait_seconds = 20\nsound = "default"\n',
      projectToml: 'wait_seconds = 5\n',
    })
    const config = loadConfig({ cwd, env })
    expect(config.wait_seconds.value).toBe(5)
    expect(config.wait_seconds.source).toMatch(/^project:/)
    expect(config.sound.value).toBe('default')
    expect(config.sound.source).toMatch(/^global:/)
  })

  it('flags beat everything', () => {
    const { env, cwd } = setup({ projectToml: 'wait_seconds = 5\n' })
    const config = loadConfig({ cwd, env, flags: { wait_seconds: 2 } })
    expect(config.wait_seconds.value).toBe(2)
    expect(config.wait_seconds.source).toBe('flag')
  })
})

describe('draft building', () => {
  const base = setup({})

  it('builds a minimal draft with defaults', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, { title: 'T', body: 'B' })
    if (!build.ok) throw new Error(build.error)
    expect(build.draft).toEqual({
      schema_version: 1,
      presentation: { title: 'T', body: 'B' },
      targets: { mode: 'all' },
      delivery: { ttl_seconds: 86400, collapse_key: null },
    })
  })

  it.each([
    {},
    { kind: 'done' },
    { kind: 'failed' },
    { kind: 'blocked' },
    { reply: true },
  ])('never derives sound or interruption level from kind: %j', (flags) => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, { title: 'T', body: 'B', ...flags })
    if (!build.ok) throw new Error(build.error)
    expect(build.draft.platform).toBeUndefined()
  })

  it('orders explicit flags over saved user config', () => {
    const { env, cwd } = setup({
      projectToml: 'sound = "alert"\ninterruption_level = "active"\n',
    })
    const config = loadConfig({ cwd, env })
    const configured = buildDraft(config, { title: 'T', body: 'B', kind: 'done' })
    if (!configured.ok) throw new Error(configured.error)
    expect(configured.draft.platform?.ios).toEqual({
      sound: 'alert',
      interruption_level: 'active',
    })

    const explicit = buildDraft(config, {
      title: 'T',
      body: 'B',
      kind: 'done',
      sound: 'none',
      level: 'time_sensitive',
    })
    if (!explicit.ok) throw new Error(explicit.error)
    expect(explicit.draft.platform?.ios).toEqual({
      sound: null,
      interruption_level: 'time_sensitive',
    })
  })

  it('keeps a blocking reply answerable for one hour by default', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, { title: 'Question', body: 'Deploy?', reply: true })
    if (!build.ok) throw new Error(build.error)

    expect(build.draft.reply?.expires_in_seconds).toBe(3_600)
  })

  it('orders explicit and configured Project identity over inference', () => {
    const { env, cwd } = setup({ projectToml: 'project = "my-app"\n' })
    const config = loadConfig({ cwd, env })
    const fromConfig = buildDraft(
      config,
      { title: 'T', body: 'B' },
      { inferredProject: 'inferred-app' },
    )
    if (!fromConfig.ok) throw new Error(fromConfig.error)
    expect(fromConfig.draft.project).toBe('my-app')
    const fromFlag = buildDraft(
      config,
      { title: 'T', body: 'B', project: 'other-app' },
      { inferredProject: 'inferred-app' },
    )
    if (!fromFlag.ok) throw new Error(fromFlag.error)
    expect(fromFlag.draft.project).toBe('other-app')

    const inferredCase = setup({})
    const unset = loadConfig({ cwd: inferredCase.cwd, env: inferredCase.env })
    const inferred = buildDraft(
      unset,
      { title: 'T', body: 'B' },
      { inferredProject: 'inferred-app' },
    )
    if (!inferred.ok) throw new Error(inferred.error)
    expect(inferred.draft.project).toBe('inferred-app')
  })

  it('carries Source Context without copying authoring overrides into legacy fields', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(
      config,
      { title: 'T', body: 'B', sessionId: 'opaque', sessionLabel: 'Visible' },
      {
        source: {
          session_id: 'opaque',
          session_label: 'Visible',
          harness: 'codex',
          branch: 'main',
          worktree: 'topic',
        },
      },
    )
    if (!build.ok) throw new Error(build.error)
    expect(build.draft.source).toEqual({
      session_id: 'opaque',
      session_label: 'Visible',
      harness: 'codex',
      branch: 'main',
      worktree: 'topic',
    })
    expect(build.draft).not.toHaveProperty('session')
  })

  it('rewrites positional media references and preserves canonical ids', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, {
      title: 'Visual result',
      body: '![first](media:1) then ![second](media:2) and ![existing](media:med_keep)',
      image: ['med_first', 'med_second', 'med_attached'],
      imageAlt: ['First image', 'Second image'],
    })
    if (!build.ok) throw new Error(build.error)
    expect(build.draft.presentation.body).toBe(
      '![first](media:med_first) then ![second](media:med_second) and ![existing](media:med_keep)',
    )
    expect(build.draft.presentation.body).not.toMatch(/media:[1-8](?!\d)/)
    expect(build.draft.presentation.media).toEqual([
      { media_id: 'med_first', alt: 'First image' },
      { media_id: 'med_second', alt: 'Second image' },
      { media_id: 'med_attached' },
    ])
  })

  it('preserves sparse alt text in an internal ordered media manifest', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, {
      title: 'Visual result',
      body: '![second](media:2)',
      media: [
        { media_id: 'med_first' },
        { media_id: 'med_second', alt: 'Second image' },
      ],
    })
    if (!build.ok) throw new Error(build.error)
    expect(build.draft.presentation.body).toBe('![second](media:med_second)')
    expect(build.draft.presentation.media).toEqual([
      { media_id: 'med_first' },
      { media_id: 'med_second', alt: 'Second image' },
    ])
  })

  it('names an out-of-range positional media reference', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, {
      title: 'Visual result',
      body: '![missing](media:3)',
      image: ['med_first', 'med_second'],
    })
    expect(build).toEqual({
      ok: false,
      error: 'Body reference "media:3" has no matching --image occurrence.',
    })
  })

  it('validates media cardinality and alt pairing', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    expect(
      buildDraft(config, {
        title: 'T',
        body: 'B',
        image: Array.from({ length: 9 }, (_, index) => `med_${index}`),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('at most 8') })
    expect(
      buildDraft(config, {
        title: 'T',
        body: 'B',
        image: ['med_one'],
        imageAlt: ['one', 'two'],
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('2 --image-alt') })
  })

  it('carries --kind and rejects one outside the vocabulary', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const done = buildDraft(config, { title: 'T', body: 'B', kind: 'done' })
    if (!done.ok) throw new Error(done.error)
    expect(done.draft.kind).toBe('done')
    // Absent stays absent rather than becoming an explicit 'update': the
    // server reads a missing field as the default, and the envelope has 4096
    // bytes to spend on things that say something.
    const plain = buildDraft(config, { title: 'T', body: 'B' })
    if (!plain.ok) throw new Error(plain.error)
    expect(plain.draft.kind).toBeUndefined()
    // Caught in the CLI so the agent gets the list, not a schema error from
    // the server after a round trip.
    const bad = buildDraft(config, { title: 'T', body: 'B', kind: 'finished' })
    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error('expected rejection')
    expect(bad.error).toContain('"done"')
  })

  it('uses configured devices unless --all is passed', () => {
    const { env, cwd } = setup({ projectToml: 'devices = ["dev_a", "dev_b"]\n' })
    const config = loadConfig({ cwd, env })
    const scoped = buildDraft(config, { title: 'T', body: 'B' })
    if (!scoped.ok) throw new Error(scoped.error)
    expect(scoped.draft.targets).toEqual({ mode: 'selected', device_ids: ['dev_a', 'dev_b'] })
    const all = buildDraft(config, { title: 'T', body: 'B', all: true })
    if (!all.ok) throw new Error(all.error)
    expect(all.draft.targets).toEqual({ mode: 'all' })
  })

  it('maps sound none to explicit null and parses custom data', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, {
      title: 'T',
      body: 'B',
      sound: 'none',
      level: 'time_sensitive',
      data: ['run_id=42', 'branch=main'],
    })
    if (!build.ok) throw new Error(build.error)
    expect(build.draft.platform?.ios).toEqual({
      sound: null,
      interruption_level: 'time_sensitive',
      custom_data: { run_id: '42', branch: 'main' },
    })
    expect(build.draft.platform?.macos).toEqual(build.draft.platform?.ios)
  })

  it('maps optional fields into the selected macOS platform slot', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    const build = buildDraft(config, {
      title: 'T',
      body: 'B',
      platform: 'macos',
      sound: 'none',
      threadId: 'desktop-builds',
      level: 'passive',
      data: ['run_id=42'],
    })
    if (!build.ok) throw new Error(build.error)

    expect(build.platform).toBe('macos')
    expect(build.draft.platform).toEqual({
      macos: {
        sound: null,
        thread_id: 'desktop-builds',
        interruption_level: 'passive',
        custom_data: { run_id: '42' },
      },
    })
  })

  it('limits collapse keys by UTF-8 bytes', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    expect(buildDraft(config, { title: 'T', body: 'B', collapseKey: '😀'.repeat(16) }).ok).toBe(
      true,
    )
    const oversized = buildDraft(config, {
      title: 'T',
      body: 'B',
      collapseKey: '😀'.repeat(17),
    })
    expect(oversized.ok).toBe(false)
    if (oversized.ok) throw new Error('expected rejection')
    expect(oversized.error).toContain('64 UTF-8 bytes')
  })

  it('rejects malformed inputs with usage errors', () => {
    const config = loadConfig({ cwd: base.cwd, env: base.env })
    expect(buildDraft(config, { title: '', body: 'B' }).ok).toBe(false)
    expect(buildDraft(config, { title: 'T', body: 'B', sound: 'airhorn' }).ok).toBe(false)
    expect(buildDraft(config, { title: 'T', body: 'B', data: ['nokey'] }).ok).toBe(false)
    expect(buildDraft(config, { title: 'T', body: 'B', level: 'shouting' }).ok).toBe(false)
    expect(buildDraft(config, { title: 'T', body: 'B', platform: 'linux' }).ok).toBe(false)
  })
})
