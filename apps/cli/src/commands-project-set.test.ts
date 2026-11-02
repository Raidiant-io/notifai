import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiClient } from './client.js'
import { EXIT, projectSetCommand, type CommandDeps } from './commands.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

type View = { project_id: string; identifier: string; display_name: string | null; image_media_id: string | null; avatar_revision: string; image_url: string | null; last_seen_at: string; settings?: { icon?: string } }

function harness(initial: Partial<View> = {}, signedIn = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-project-set-'))
  roots.push(root)
  const logo = path.join(root, 'thebeacon logo.png')
  const image = new PNG({ width: 40, height: 20 })
  image.data.fill(200)
  writeFileSync(logo, PNG.sync.write(image))
  let view: View = { project_id: 'proj_1', identifier: 'the-beacon', display_name: null, image_media_id: null, avatar_revision: 'generated:v1', image_url: null, last_seen_at: 'now', ...initial }
  const calls: string[] = []
  const uploaded: { size_bytes: number; media_type: string }[] = []
  const client = {
    registerProject: async (identifier: string) => { calls.push(`register:${identifier}`); return view },
    updateProject: async (_id: string, body: { display_name?: string | null }) => { calls.push('update'); view = { ...view, display_name: body.display_name ?? null }; return view },
    setProjectAvatar: async (_id: string, artifact: { size_bytes: number; media_type: string }) => { calls.push('avatar'); uploaded.push(artifact); view = { ...view, image_media_id: 'med_1' }; return view },
    setProjectIcon: async (_id: string, icon: string) => { calls.push(`icon:${icon}`); view = { ...view, image_media_id: null, settings: { icon } }; return view },
    clearProjectAvatar: async () => { calls.push('clear'); view = { ...view, image_media_id: null, settings: {} }; return view },
  } as unknown as ApiClient
  const out: string[] = []
  const err: string[] = []
  const deps: CommandDeps = {
    io: { out: (l) => out.push(l), err: (l) => err.push(l), confirm: async () => false, openUrl: () => {} },
    store: { load: () => (signedIn ? { machineId: 'mac_1', secret: 's', baseUrl: 'https://notifai.sh', machineName: 'M' } : null), save: () => {}, clear: () => {}, describe: () => 'test' },
    env: { XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), HOME: root },
    cwd: root,
    clientFactory: () => client,
  }
  return { deps, out, err, calls, uploaded, logo, root }
}

describe('notifai project set', () => {
  it('sets the display name and a normalized avatar for a Project id, as JSON', async () => {
    const t = harness()
    const code = await projectSetCommand(t.deps, { project: 'the-beacon', name: '  The Beacon ', avatar: t.logo, json: true })
    expect(code).toBe(EXIT.ok)
    expect(t.calls).toEqual(['register:the-beacon', 'update', 'avatar'])
    expect(t.uploaded[0]).toMatchObject({ media_type: 'image/png' })
    expect(JSON.parse(t.out[0]!)).toMatchObject({ ok: true, project: 'the-beacon', display_name: 'The Beacon', custom_avatar: true, changed: { name: true, avatar: 'set' } })
  })

  it('refuses to overwrite a name or avatar already set, changing nothing, until --replace', async () => {
    const t = harness({ display_name: 'Beacon Old', image_media_id: 'med_old' })
    const refused = await projectSetCommand(t.deps, { project: 'the-beacon', name: 'The Beacon', avatar: t.logo, json: true })
    expect(refused).toBe(EXIT.usage)
    expect(t.calls).toEqual(['register:the-beacon'])
    const body = JSON.parse(t.out[0]!)
    expect(body).toMatchObject({ ok: false, error: { code: 'already_set' } })
    expect(body.error.message).toContain('--replace')
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', name: 'The Beacon', avatar: t.logo, replace: true, json: true })).toBe(EXIT.ok)
    expect(t.calls.slice(1)).toEqual(['register:the-beacon', 'update', 'avatar'])
  })

  it('treats a picked icon as an avatar the User chose, and removes only with --replace', async () => {
    const t = harness({ settings: { icon: 'rocket' } })
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', removeAvatar: true })).toBe(EXIT.usage)
    expect(t.calls).toEqual(['register:the-beacon'])
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', removeAvatar: true, replace: true })).toBe(EXIT.ok)
    expect(t.calls.at(-1)).toBe('clear')
  })

  it('does nothing when the name already matches and there is no avatar to remove', async () => {
    const t = harness({ display_name: 'The Beacon' })
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', name: 'The Beacon' })).toBe(EXIT.ok)
    expect(t.calls).toEqual(['register:the-beacon'])
    expect(t.out[0]).toContain('nothing changed')
  })

  it('keeps the Project id separate from the display name and checks local input before any request', async () => {
    const t = harness()
    expect(await projectSetCommand(t.deps, { project: 'The Beacon', name: 'The Beacon' })).toBe(EXIT.usage)
    expect(t.err[0]).toContain('not a Project id')
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', avatar: path.join(t.root, 'missing.png') })).toBe(EXIT.usage)
    const notImage = path.join(t.root, 'notes.txt')
    writeFileSync(notImage, 'not an image')
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', avatar: notImage, json: true })).toBe(EXIT.usage)
    expect(JSON.parse(t.out[0]!).error.code).toBe('unsupported_avatar_type')
    expect(await projectSetCommand(t.deps, { project: 'the-beacon' })).toBe(EXIT.usage)
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', avatar: t.logo, removeAvatar: true })).toBe(EXIT.usage)
    expect(t.calls).toEqual([])
  })

  it('reports being signed out', async () => {
    const t = harness({}, false)
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', name: 'X' })).toBe(EXIT.auth)
  })

  it('names the Project and picks one icon in a single command', async () => {
    const t = harness()
    const code = await projectSetCommand(t.deps, { project: 'the-beacon', name: 'The Beacon', icon: 'radio', json: true })
    expect(code).toBe(EXIT.ok)
    expect(t.calls).toEqual(['register:the-beacon', 'update', 'icon:radio'])
    expect(JSON.parse(t.out[0]!)).toMatchObject({ ok: true, display_name: 'The Beacon', changed: { name: true, avatar: 'icon' } })
  })

  it('rejects an unknown icon, and an icon together with an avatar, before any request', async () => {
    const t = harness()
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', icon: 'not-an-icon' })).toBe(EXIT.usage)
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', icon: 'radio', avatar: t.logo })).toBe(EXIT.usage)
    expect(t.calls).toEqual([])
    expect(t.err.join('\n')).toContain('notifai project icons')
  })

  it('leaves an avatar the User picked alone unless --replace', async () => {
    const t = harness({ settings: { icon: 'rocket' } })
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', icon: 'radio', json: true })).toBe(EXIT.usage)
    expect(t.calls).toEqual(['register:the-beacon'])
    expect(await projectSetCommand(t.deps, { project: 'the-beacon', icon: 'radio', replace: true, json: true })).toBe(EXIT.ok)
    expect(t.calls).toEqual(['register:the-beacon', 'register:the-beacon', 'icon:radio'])
  })
})
