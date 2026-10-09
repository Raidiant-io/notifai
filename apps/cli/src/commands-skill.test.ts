import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { SkillInstallation } from './skill-installation.js'
import { sameLocalPath } from './local-path.js'
import { nativeSkills } from './native-skills.js'
import { localIntegrationAssessment } from './integration-health.js'
import { updateSkillCommand } from './commands-update-skill.js'
import { skillReadiness } from './commands-skill.js'
import * as integrity from './skill-integrity.js'
import { createSkillManifest, shippedSkillBundle, verifySkillBundle } from './skill-integrity.js'

describe('development CLI skill parity', () => {
  it('reports an exact gap instead of calling a stale released skill ready', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-dev-skill-'))
    const installedPath = path.join(root, 'skills', 'notifai')
    mkdirSync(installedPath, { recursive: true })
    writeFileSync(path.join(installedPath, 'SKILL.md'), '# stale released skill\n')
    const deps = {
      cwd: root,
      env: {},
      io: { out() {}, err() {}, confirm: async () => false, openUrl() {} },
      store: { load: () => null, save() {}, clear() {}, describe: () => 'test' },
      nativeSkills: {
        list: async (scope: 'project' | 'global') => ({
          skills: scope === 'global'
            ? [{ name: 'notifai', owned: true, scope, path: installedPath, source: null, sourceType: null, sourceUrl: null, ref: null }]
            : [],
        }),
        add: async () => 0,
        remove: async () => 0,
      },
    } satisfies CommandDeps

    const state = await skillReadiness(deps)
    expect(state).toMatchObject({
      status: 'gap',
      technical: {
        resolution: 'development-cli-skill-mismatch',
        ref: null,
        checkout_digest: expect.stringMatching(/^sha256:/),
        installed_digest: expect.stringMatching(/^sha256:/),
      },
    })
    expect(state.remedy).toBeUndefined()
  })
})

describe('harness-specific skill copies', () => {
  function installed(): { deps: CommandDeps; root: string; claude: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-skill-copies-'))
    const bundle = shippedSkillBundle()
    if (!bundle.ok) throw new Error(bundle.error)
    const conventional = path.join(root, '.agents', 'skills', 'notifai')
    cpSync(bundle.bundle.skillRoot, conventional, { recursive: true })
    const claude = path.join(root, '.claude', 'skills', 'notifai')
    cpSync(bundle.bundle.skillRoot, claude, { recursive: true })
    const deps = {
      cwd: root,
      env: { HOME: root, USERPROFILE: root },
      io: { out() {}, err() {}, confirm: async () => false, openUrl() {} },
      store: { load: () => null, save() {}, clear() {}, describe: () => 'test' },
      nativeSkills: {
        list: async (scope: 'project' | 'global') => ({
          skills: scope === 'global'
            ? [{ name: 'notifai', owned: true, scope, path: conventional, source: null, sourceType: null, sourceUrl: null, ref: null }]
            : [],
        }),
        add: async () => 0,
        remove: async () => 0,
      },
    } satisfies CommandDeps
    return { deps, root, claude }
  }

  it('is ready when every harness copy matches the shipped guidance', async () => {
    expect(await skillReadiness(installed().deps)).toMatchObject({ status: 'ready' })
  })

  it('reports the harness that loads an older copy instead of calling the skill ready', async () => {
    const f = installed()
    writeFileSync(path.join(f.claude, 'SKILL.md'), '# older guidance\n')
    const state = await skillReadiness(f.deps)
    expect(state).toMatchObject({
      status: 'gap',
      detail: expect.stringContaining('Claude Code loads its own copy'),
      technical: {
        resolution: 'stale-harness-skill-copy',
        stale_copies: [{ agent: 'claude-code', path: f.claude }],
      },
      remedy: { by: 'cli', command: 'notifai init --skills --skills-scope global' },
    })
  })
})

// Cross-command acceptance uses the production inventory and real receipt store.
// Only output and installation calls are observed; no service or host setup runs.
describe('ownership-aware skill diagnostics', () => {
  const roots: string[] = []
  afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  function fixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-skill-custody-'))
    roots.push(root)
    const cwd = path.join(root, 'project'), home = path.join(root, 'home')
    mkdirSync(cwd); mkdirSync(home)
    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_STATE_HOME: path.join(root, 'state'), PATH: '' }
    const bundle = shippedSkillBundle()
    if (!bundle.ok) throw new Error(bundle.error)
    const out: string[] = []
    const add = vi.fn(nativeSkills.add), remove = vi.fn(nativeSkills.remove)
    const deps = { cwd, env, nativeSkills: { ...nativeSkills, add, remove },
      io: { out: (line: string) => out.push(line), err() {} },
    } as unknown as CommandDeps
    const destination = (scope: 'project' | 'global') => path.join(scope === 'project' ? cwd : home, '.agents', 'skills', 'notifai')
    const faults = () => localIntegrationAssessment(deps).faults.filter(fault => fault.code.startsWith('skill-'))
    const install = (scope: 'project' | 'global', agents: ('codex' | 'claude-code')[] = ['codex']) => {
      expect(new SkillInstallation({ cwd, env }).reconcile({ scope, agents, bundle: bundle.bundle }).ok).toBe(true)
    }
    return { root, cwd, home, env, deps, bundle: bundle.bundle, destination, faults, install, out, add, remove }
  }
  it.each(['project', 'global'] as const)('keeps absent optional %s guidance non-faulting', async scope => {
    const f = fixture()
    expect(await nativeSkills.list(scope, f.cwd, f.env)).toEqual({ skills: [] })
    expect(await skillReadiness(f.deps)).toMatchObject({ status: 'optional-gap' })
    expect(f.faults()).toEqual([])
  })
  it.each([
    ['project', false], ['global', false], ['project', true], ['global', true],
  ] as const)('preserves unowned %s guidance with modified=%s across doctor, check and refresh', async (scope, modified) => {
    const f = fixture(), target = f.destination(scope)
    cpSync(f.bundle.skillRoot, target, { recursive: true })
    if (modified) writeFileSync(path.join(target, 'SKILL.md'), 'User authored guidance')
    const before = createSkillManifest(target, '')
    expect(await nativeSkills.list(scope, f.cwd, f.env)).toMatchObject({ skills: [{ owned: false, condition: 'unmanaged' }] })
    expect(await skillReadiness(f.deps)).toMatchObject({ status: 'gap', technical: { resolution: 'skill-unmanaged' } })
    expect(f.faults()).toMatchObject([{ code: 'skill-unmanaged', remedy: expect.stringContaining('Only after that custody decision') }])
    expect(await updateSkillCommand(f.deps, { json: true })).toBe(1)
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ error: expect.stringContaining('do not adopt, overwrite, move or delete') })
    expect(f.add).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled()
    expect(createSkillManifest(target, '')).toEqual(before)
    expect(existsSync(path.join(f.env.XDG_STATE_HOME, 'notifai', 'skill-installations'))).toBe(false)
  })
  it('reports unowned duplicate scopes without recommending automatic cleanup', async () => {
    const f = fixture()
    for (const scope of ['project', 'global'] as const) cpSync(f.bundle.skillRoot, f.destination(scope), { recursive: true })
    const state = await skillReadiness(f.deps)
    expect(state).toMatchObject({ status: 'gap', technical: { resolution: 'skill-unmanaged', copies: expect.arrayContaining([
      expect.objectContaining({ scope: 'project', owned: false }), expect.objectContaining({ scope: 'global', owned: false }),
    ]) } })
    expect(f.faults()).toMatchObject([{ code: 'skill-unmanaged' }])
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(f.add).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled()
  })
  it('does not hide an extra unowned harness copy behind a current owned receipt', async () => {
    const f = fixture(); f.install('global')
    const extra = path.join(f.home, '.claude', 'skills', 'notifai')
    cpSync(f.bundle.skillRoot, extra, { recursive: true })
    expect(await nativeSkills.list('global', f.cwd, f.env)).toMatchObject({ skills: [
      { owned: true, condition: 'managed-current' }, { path: extra, owned: false, condition: 'unmanaged' },
    ] })
    expect(await skillReadiness(f.deps)).toMatchObject({ technical: { resolution: 'skill-unmanaged' } })
    expect(f.faults()).toMatchObject([{ code: 'skill-unmanaged' }])
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(f.add).not.toHaveBeenCalled()
    expect(createSkillManifest(extra, '').digest).toBe(f.bundle.manifest.digest)
  })
  it('accepts an intact current receipt and refuses edited owned content', async () => {
    const f = fixture(); f.install('global')
    expect(await skillReadiness(f.deps)).toMatchObject({ status: 'ready' })
    expect(f.faults()).toEqual([])
    expect(await updateSkillCommand(f.deps, {})).toBe(0)
    const target = path.join(f.destination('global'), 'SKILL.md')
    writeFileSync(target, 'User edited owned guidance')
    expect(await nativeSkills.list('global', f.cwd, f.env)).toMatchObject({ skills: [{ owned: true, condition: 'managed-modified' }] })
    expect(await skillReadiness(f.deps)).toMatchObject({ technical: { resolution: 'skill-modified' } })
    expect(f.faults()).toMatchObject([{ code: 'skill-modified' }])
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(f.add).not.toHaveBeenCalled()
    expect(readFileSync(target, 'utf8')).toBe('User edited owned guidance')
  })
  it('refreshes an intact stale receipt in its recorded scope and harness placement', async () => {
    const f = fixture(), source = path.join(f.root, 'old-bundle'), tree = path.join(source, 'notifai')
    cpSync(f.bundle.skillRoot, tree, { recursive: true })
    writeFileSync(path.join(tree, 'SKILL.md'), 'Older released guidance')
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(createSkillManifest(tree, '1.0.0')))
    const old = verifySkillBundle(source)
    if (!old.ok) throw new Error(old.error)
    expect(new SkillInstallation(f.deps).reconcile({ scope: 'global', agents: ['claude-code'], bundle: old.bundle }).ok).toBe(true)
    expect(await nativeSkills.list('global', f.cwd, f.env)).toMatchObject({ skills: [{ owned: true, condition: 'managed-stale' }] })
    expect(await skillReadiness(f.deps)).toMatchObject({ status: 'gap', technical: { resolution: 'installed-skill-content-mismatch' } })
    expect(f.faults()).toMatchObject([{ code: 'skill-drift', remedy: 'notifai update --refresh-skill --json' }])
    expect(await updateSkillCommand(f.deps, {})).toBe(0)
    expect(f.add).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global' }))
    expect(await nativeSkills.list('global', f.cwd, f.env)).toMatchObject({ skills: [{ owned: true, condition: 'managed-current', agents: ['claude-code'] }] })
    expect(existsSync(f.destination('global'))).toBe(false)
    expect(f.faults()).toEqual([])
  })
  it('detects duplicate managed scopes without choosing a refresh scope', async () => {
    const f = fixture(); f.install('project'); f.install('global')
    expect(await skillReadiness(f.deps)).toMatchObject({ status: 'gap' })
    expect(f.faults()).toMatchObject([{ code: 'skill-scope-ambiguous' }])
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(f.add).not.toHaveBeenCalled()
  })
  it.each(['missing-entrypoint', 'root-link', 'parent-link', 'file-root'] as const)('preserves %s and does not confuse it with absent optional guidance', async kind => {
    const f = fixture(), target = f.destination('global')
    mkdirSync(path.dirname(target), { recursive: true })
    if (kind === 'missing-entrypoint') mkdirSync(target)
    if (kind === 'file-root') writeFileSync(target, 'Not a directory')
    if (kind === 'root-link') symlinkSync(f.bundle.skillRoot, target, 'dir')
    if (kind === 'parent-link') {
      rmSync(path.dirname(target), { recursive: true })
      const trees = path.join(f.root, 'foreign-skills'); mkdirSync(trees)
      cpSync(f.bundle.skillRoot, path.join(trees, 'notifai'), { recursive: true })
      symlinkSync(trees, path.dirname(target), 'dir')
    }
    const state = await skillReadiness(f.deps)
    expect(state.status).toBe('gap')
    expect(f.faults()[0]?.code).toBe(kind.includes('link') ? 'skill-unreadable' : 'skill-incomplete')
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(f.add).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports an unreadable tree consistently and preserves its bytes', async () => {
    const f = fixture(), target = f.destination('global')
    cpSync(f.bundle.skillRoot, target, { recursive: true }); chmodSync(target, 0)
    try {
      expect(await skillReadiness(f.deps)).toMatchObject({ technical: { resolution: 'skill-unreadable' } })
      expect(f.faults()).toMatchObject([{ code: 'skill-unreadable' }])
      expect(await updateSkillCommand(f.deps, {})).toBe(1)
      expect(f.add).not.toHaveBeenCalled()
    } finally { chmodSync(target, 0o700) }
    expect(createSkillManifest(target, '').digest).toBe(f.bundle.manifest.digest)
  })
  it.each(['claude', 'hermes', 'grok', 'openclaw', 'cursor', 'opencode'] as const)('discovers unmanaged global %s placements independently of conventional guidance', async harness => {
    const f = fixture(), configured = path.join(f.root, 'configured')
    const paths = { claude: path.join(configured, 'skills', 'notifai'), hermes: path.join(configured, 'skills', 'notifai'),
      grok: path.join(configured, 'skills', 'notifai'), openclaw: path.join(configured, 'skills', 'notifai'),
      cursor: path.join(f.home, '.cursor', 'skills', 'notifai'), opencode: path.join(f.home, '.config', 'opencode', 'skills', 'notifai') }
    Object.assign(f.env, { CLAUDE_CONFIG_DIR: harness === 'claude' ? configured : path.join(f.home, '.claude'),
      HERMES_HOME: harness === 'hermes' ? configured : path.join(f.home, '.hermes'),
      GROK_HOME: harness === 'grok' ? configured : path.join(f.home, '.grok'),
      OPENCLAW_STATE_DIR: harness === 'openclaw' ? configured : path.join(f.home, '.openclaw') })
    cpSync(f.bundle.skillRoot, paths[harness], { recursive: true })
    expect(await nativeSkills.list('global', f.cwd, f.env)).toMatchObject({ skills: [{ path: paths[harness], owned: false, condition: 'unmanaged' }] })
    expect(await skillReadiness(f.deps)).toMatchObject({ technical: { resolution: 'skill-unmanaged' } })
    expect(f.faults()).toMatchObject([{ code: 'skill-unmanaged' }])
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(f.add).not.toHaveBeenCalled()
  })
  it('does not require a package bundle to diagnose absent or unowned guidance', async () => {
    const f = fixture()
    const bundleRead = vi.spyOn(integrity, 'shippedSkillBundle').mockImplementation(() => { throw new Error('unneeded bundle scan') })
    expect(f.faults()).toEqual([])
    expect(await skillReadiness(f.deps)).toMatchObject({ status: 'optional-gap' })
    cpSync(f.bundle.skillRoot, f.destination('global'), { recursive: true })
    expect(f.faults()).toMatchObject([{ code: 'skill-unmanaged' }])
    expect(await skillReadiness(f.deps)).toMatchObject({ technical: { resolution: 'skill-unmanaged' } })
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(bundleRead).not.toHaveBeenCalled(); expect(f.add).not.toHaveBeenCalled()
  })
  it('reports an unverifiable bundled package as unavailable rather than refreshable stale guidance', async () => {
    const f = fixture(); f.install('global')
    vi.spyOn(integrity, 'shippedSkillBundle').mockReturnValue({ ok: false, error: 'packaged manifest and CLI version differ' })
    expect(await skillReadiness(f.deps)).toMatchObject({ status: 'gap', technical: { resolution: 'skill-bundle-unavailable' } })
    expect(f.faults()).toMatchObject([{ code: 'skill-bundle-unavailable' }])
    expect(f.faults()[0]?.remedy).not.toContain('notifai update --refresh-skill')
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(f.add).not.toHaveBeenCalled()
  })
  it('repairs missing owned guidance and a pending first placement in their recorded scope', async () => {
    const f = fixture(); f.install('global')
    rmSync(f.destination('global'), { recursive: true })
    expect(await skillReadiness(f.deps)).toMatchObject({ status: 'gap', technical: { resolution: 'installed-skill-content-mismatch' } })
    expect(f.faults()).toMatchObject([{ code: 'skill-drift' }])
    expect(await updateSkillCommand(f.deps, {})).toBe(0)
    expect(f.add).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global' }))
    expect(await skillReadiness(f.deps)).toMatchObject({ status: 'ready' })
    const other = fixture()
    const installer = new SkillInstallation({ cwd: other.cwd, env: other.env, observe(phase) {
      if (phase === 'prepared') throw new Error('simulated first-placement interruption')
    } })
    expect(installer.reconcile({ scope: 'global', agents: ['codex'], bundle: other.bundle }).ok).toBe(false)
    expect(await skillReadiness(other.deps)).toMatchObject({ status: 'gap', technical: { resolution: 'installed-skill-content-mismatch' } })
    expect(other.faults()).toMatchObject([{ code: 'skill-drift' }])
    expect(await updateSkillCommand(other.deps, {})).toBe(0)
    expect(other.add).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global' }))
    expect(await skillReadiness(other.deps)).toMatchObject({ status: 'ready' })
  })
  it('preserves an existing owned directory whose entrypoint was deleted', async () => {
    const f = fixture(); f.install('global')
    const target = f.destination('global')
    rmSync(path.join(target, 'SKILL.md'))
    const before = createSkillManifest(target, '')
    expect(await nativeSkills.list('global', f.cwd, f.env)).toMatchObject({ skills: [{ owned: true, condition: 'incomplete' }] })
    expect(await skillReadiness(f.deps)).toMatchObject({ technical: { resolution: 'skill-incomplete' } })
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(f.add).not.toHaveBeenCalled()
    expect(createSkillManifest(target, '')).toEqual(before)
    expect(existsSync(path.join(target, 'SKILL.md'))).toBe(false)
  })
  it('resumes a pending new harness placement alongside existing owned placements', async () => {
    const f = fixture(); f.install('global')
    const interrupted = new SkillInstallation({ cwd: f.cwd, env: f.env, observe(phase) {
      if (phase === 'prepared') throw new Error('simulated new-harness interruption')
    } })
    expect(interrupted.reconcile({ scope: 'global', agents: ['codex', 'claude-code'], bundle: f.bundle }).ok).toBe(false)
    const pending = await nativeSkills.list('global', f.cwd, f.env)
    expect(pending).toMatchObject({ skills: [{ owned: true, condition: 'managed-pending', agents: ['codex', 'claude-code'] }] })
    expect(pending.skills[0]!.placements!.some(item => sameLocalPath(item.path,
      path.join(f.home, '.claude', 'skills', 'notifai')))).toBe(true)
    expect(await updateSkillCommand(f.deps, {})).toBe(0)
    expect(await nativeSkills.list('global', f.cwd, f.env)).toMatchObject({ skills: [{ owned: true, condition: 'managed-current',
      agents: ['codex', 'claude-code'] }] })
    expect(f.faults()).toEqual([])
  })
  it.each([
    ['project', 'prepared'], ['global', 'prepared'], ['project', 'old-retained'],
    ['global', 'old-retained'], ['project', 'published'], ['global', 'published'],
  ] as const)('resumes %s receipt-backed replacement interrupted at %s', async (scope, stage) => {
    const f = fixture(), source = path.join(f.root, 'previous-bundle'), tree = path.join(source, 'notifai')
    cpSync(f.bundle.skillRoot, tree, { recursive: true })
    writeFileSync(path.join(tree, 'SKILL.md'), 'Previous verified release guidance')
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(createSkillManifest(tree, '1.0.0')))
    const previous = verifySkillBundle(source)
    if (!previous.ok) throw new Error(previous.error)
    expect(new SkillInstallation(f.deps).reconcile({ scope, agents: ['claude-code'], bundle: previous.bundle }).ok).toBe(true)
    const interrupted = new SkillInstallation({ cwd: f.cwd, env: f.env, observe(phase) {
      if (phase === stage) throw new Error('simulated replacement interruption')
    } })
    expect(interrupted.reconcile({ scope, bundle: f.bundle }).ok).toBe(false)
    expect(await nativeSkills.list(scope, f.cwd, f.env)).toMatchObject({ skills: [{ owned: true, pending: true,
      condition: 'managed-pending', agents: ['claude-code'] }] })
    expect(f.faults()).toMatchObject([{ code: 'skill-drift' }])
    expect(await updateSkillCommand(f.deps, {})).toBe(0)
    expect(f.add).toHaveBeenCalledWith(expect.objectContaining({ scope }))
    expect(await nativeSkills.list(scope, f.cwd, f.env)).toMatchObject({ skills: [{ pending: false,
      condition: 'managed-current', agents: ['claude-code'] }] })
    expect(f.faults()).toEqual([])
    const target = path.join(scope === 'project' ? f.cwd : f.home, '.claude', 'skills', 'notifai')
    expect(createSkillManifest(target, '').digest).toBe(f.bundle.manifest.digest)
    expect(readdirSync(path.dirname(target))).toEqual(['notifai'])
    expect(existsSync(f.destination(scope))).toBe(false)
  })
  it.each(['destination', 'staged', 'backup'] as const)('preserves modified %s content in an owned interrupted replacement', async changed => {
    const f = fixture(), source = path.join(f.root, 'previous-bundle'), tree = path.join(source, 'notifai')
    cpSync(f.bundle.skillRoot, tree, { recursive: true })
    writeFileSync(path.join(tree, 'SKILL.md'), 'Previous verified release guidance')
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(createSkillManifest(tree, '1.0.0')))
    const previous = verifySkillBundle(source)
    if (!previous.ok) throw new Error(previous.error)
    expect(new SkillInstallation(f.deps).reconcile({ scope: 'global', agents: ['codex'], bundle: previous.bundle }).ok).toBe(true)
    const stage = changed === 'backup' ? 'published' : 'prepared'
    const interrupted = new SkillInstallation({ cwd: f.cwd, env: f.env, observe(phase) {
      if (phase === stage) throw new Error('simulated replacement interruption')
    } })
    expect(interrupted.reconcile({ scope: 'global', bundle: f.bundle }).ok).toBe(false)
    const parent = path.dirname(f.destination('global'))
    const selected = changed === 'destination' ? f.destination('global') : path.join(parent,
      readdirSync(parent).find(name => name.endsWith(changed === 'staged' ? '.new' : '.old'))!)
    const edited = path.join(selected, 'SKILL.md')
    writeFileSync(edited, 'Foreign replacement content')
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(readFileSync(edited, 'utf8')).toBe('Foreign replacement content')
    if (changed === 'destination') expect(f.add).not.toHaveBeenCalled()
    else expect(f.add).toHaveBeenCalledTimes(1)
  })
  it('does not borrow ownership from a managed target through an unreceipted harness symlink', async () => {
    const f = fixture(); f.install('global')
    const extra = path.join(f.home, '.claude', 'skills', 'notifai')
    mkdirSync(path.dirname(extra), { recursive: true }); symlinkSync(f.destination('global'), extra, 'dir')
    expect(await nativeSkills.list('global', f.cwd, f.env)).toMatchObject({ skills: [
      { owned: true, condition: 'managed-current' }, { owned: false, condition: 'unreadable', path: extra },
    ] })
    expect(await skillReadiness(f.deps)).toMatchObject({ technical: { resolution: 'skill-unreadable' } })
    expect(f.faults()).toMatchObject([{ code: 'skill-unreadable' }])
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(f.add).not.toHaveBeenCalled()
  })
  it('does not treat omitted ownership in an injected inventory as a managed installation', async () => {
    const f = fixture(); f.install('global')
    const owned = (await nativeSkills.list('global', f.cwd, f.env)).skills[0]!
    const unowned = { ...owned }
    delete unowned.owned; delete unowned.condition
    f.deps.nativeSkills!.list = async scope => ({ skills: scope === 'global' ? [unowned] : [] })
    f.deps.nativeSkills!.inspect = scope => ({ skills: scope === 'global' ? [unowned] : [] })
    expect(await skillReadiness(f.deps)).toMatchObject({ technical: { resolution: 'skill-unmanaged' } })
    expect(f.faults()).toMatchObject([{ code: 'skill-unmanaged' }])
    expect(await updateSkillCommand(f.deps, {})).toBe(1)
    expect(f.add).not.toHaveBeenCalled()
  })
  it('honors bounded receipt inspection without calling content modified or absent', () => {
    const f = fixture(); f.install('global')
    const expired = { maxFiles: 100, maxBytes: 2 * 1024 * 1024, deadlineAt: Date.now() - 1 }
    expect(nativeSkills.inspect!('global', f.cwd, f.env, expired)).toMatchObject({ skills: [], error: expect.stringContaining('Inspection incomplete') })
    expect(localIntegrationAssessment(f.deps, undefined, expired).faults).toMatchObject([{ code: 'skill-inspection-incomplete' }])
    const small = { ...expired, deadlineAt: Date.now() + 1_000, maxFiles: 0 }
    expect(nativeSkills.inspect!('global', f.cwd, f.env, small)).toMatchObject({ skills: [], error: expect.stringContaining('Inspection incomplete') })
    expect(readFileSync(path.join(f.destination('global'), 'SKILL.md'))).toEqual(readFileSync(path.join(f.bundle.skillRoot, 'SKILL.md')))
  })
})
