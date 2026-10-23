import type * as NodeFs from 'node:fs'
import { lstatSync, linkSync, readFileSync, renameSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NOTIFICATION_IMAGE_MAX_BYTES } from '@raidiant/notifai-protocol'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_TEXT_MAX_BYTES, readLocalImage, readLocalText } from './local-input.js'

// Only scheduling is replaced: all files, descriptors and metadata are real.
const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as (() => void) | undefined,
  afterOpen: undefined as (() => void) | undefined,
  rootOwnedLink: undefined as string | undefined,
  aliasTarget: undefined as string | undefined,
  unownedAlias: undefined as string | undefined,
}))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof NodeFs>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const before = hooks.beforeOpen
      hooks.beforeOpen = undefined
      before?.()
      const fd = fs.openSync(...args)
      const after = hooks.afterOpen
      hooks.afterOpen = undefined
      after?.()
      return fd
    },
    readlinkSync: (...args: Parameters<typeof fs.readlinkSync>) => {
      if (String(args[0]) === '/tmp' && hooks.aliasTarget !== undefined) return hooks.aliasTarget
      return fs.readlinkSync(...args)
    },
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      const stat = fs.lstatSync(...args)
      if (stat === undefined) return stat
      const isRoot = String(args[0]) === hooks.rootOwnedLink
      const unowned = String(args[0]) === hooks.unownedAlias
      if (!isRoot && !unowned) return stat
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        uid: typeof stat.uid === 'bigint' ? (unowned ? 1000n : 0n) : (unowned ? 1000 : 0),
      })
    },
  }
})
afterEach(() => {
  hooks.beforeOpen = undefined
  hooks.afterOpen = undefined
  hooks.rootOwnedLink = undefined
  hooks.aliasTarget = undefined
  hooks.unownedAlias = undefined
})

/**
 * A cloned repository can commit a symbolic link to anywhere on the machine,
 * and an agent that follows the repository's instructions passes the link's
 * innocent-looking path. These tests play that repository.
 */

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'notifai-local-input-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----\n'

let counter = 0
/** A fresh home holding `.ssh/id_ed25519`, and a repository checkout inside it. */
function machine(): { home: string; repo: string; key: string } {
  const home = path.join(root, `home-${counter++}`)
  const repo = path.join(home, 'src', 'cloned')
  mkdirSync(path.join(home, '.ssh'), { recursive: true })
  mkdirSync(path.join(repo, 'assets'), { recursive: true })
  const key = path.join(home, '.ssh', 'id_ed25519')
  writeFileSync(key, KEY)
  return { home, repo, key }
}

// Windows creates symbolic links only with Developer Mode or elevation.
const canLink = (() => {
  try {
    symlinkSync(root, path.join(root, 'probe-link'), 'dir')
    return true
  } catch {
    return false
  }
})()

describe('local images', () => {
  it('reads a regular image whose bytes match its type', () => {
    const { repo } = machine()
    writeFileSync(path.join(repo, 'assets', 'shot.png'), PNG)
    const read = readLocalImage(repo, 'assets/shot.png', '--image')
    expect(read).toEqual({ ok: true, path: path.join(repo, 'assets', 'shot.png'), bytes: new Uint8Array(PNG), mediaType: 'image/png' })
  })

  it.runIf(canLink)('refuses a repository image that links to an SSH key', () => {
    // The scenario: the repository commits assets/preview.png as a link to
    // ../../../.ssh/id_ed25519 and asks for it on completion notifications.
    const { repo } = machine()
    symlinkSync(path.join('..', '..', '..', '.ssh', 'id_ed25519'), path.join(repo, 'assets', 'preview.png'))
    expect(readLocalImage(repo, 'assets/preview.png', '--image')).toEqual({
      ok: false,
      error: '--image "assets/preview.png" is a symbolic link; Notifai reads only the file itself.',
    })
  })

  it.runIf(canLink)('refuses a link to a real image too, so a link cannot pick a private picture', () => {
    const { home, repo } = machine()
    writeFileSync(path.join(home, 'private.png'), PNG)
    symlinkSync(path.join(home, 'private.png'), path.join(repo, 'assets', 'preview.png'))
    const read = readLocalImage(repo, 'assets/preview.png', '--image')
    expect(read.ok).toBe(false)
  })

  it.runIf(canLink)('refuses an image reached through a linked folder', () => {
    const { home, repo } = machine()
    writeFileSync(path.join(home, '.ssh', 'shot.png'), PNG)
    symlinkSync(path.join(home, '.ssh'), path.join(repo, 'screens'), 'dir')
    expect(readLocalImage(repo, 'screens/shot.png', '--image')).toEqual({
      ok: false,
      error: `--image "screens/shot.png" goes through the symbolic link ${path.join(repo, 'screens')}; Notifai reads files only through real folders.`,
    })
  })

  it('refuses a key renamed to look like an image', () => {
    const { repo } = machine()
    writeFileSync(path.join(repo, 'assets', 'id_ed25519.png'), KEY)
    expect(readLocalImage(repo, 'assets/id_ed25519.png', '--image')).toEqual({
      ok: false,
      error: '--image "assets/id_ed25519.png" is not the PNG image its name says.',
    })
  })

  it('refuses an image type it does not send, a folder, a missing file and an oversized one', () => {
    const { repo } = machine()
    writeFileSync(path.join(repo, 'notes.txt'), 'hello')
    mkdirSync(path.join(repo, 'dir.png'))
    writeFileSync(path.join(repo, 'huge.png'), Buffer.concat([PNG, Buffer.alloc(NOTIFICATION_IMAGE_MAX_BYTES)]))
    expect(readLocalImage(repo, 'notes.txt', '--image')).toEqual({ ok: false, error: '--image "notes.txt" must be a JPEG, PNG or GIF file.' })
    expect(readLocalImage(repo, 'dir.png', '--image')).toEqual({ ok: false, error: '--image "dir.png" is not a regular file.' })
    expect(readLocalImage(repo, 'missing.png', '--image')).toEqual({ ok: false, error: '--image "missing.png" does not exist.' })
    expect(readLocalImage(repo, 'huge.png', '--image')).toEqual({
      ok: false,
      error: `--image "huge.png" is larger than ${NOTIFICATION_IMAGE_MAX_BYTES} bytes.`,
    })
  })
})

describe('local text files', () => {
  it('reads a Body the agent wrote to a temporary file', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-body-'))
    try {
      // os.tmpdir() sits under a system-owned link on macOS (/var); that link
      // is the system's, not a repository's, so the read goes ahead.
      writeFileSync(path.join(scratch, 'body.md'), 'The deploy finished.\n')
      expect(readLocalText(process.cwd(), path.join(scratch, 'body.md'), '--body-file')).toEqual({ ok: true, text: 'The deploy finished.\n' })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it.runIf(canLink)('refuses a Body file that links to an SSH key', () => {
    const { repo } = machine()
    symlinkSync(path.join('..', '..', '..', '.ssh', 'id_ed25519'), path.join(repo, 'assets', 'summary.md'))
    expect(readLocalText(repo, 'assets/summary.md', '--body-file')).toEqual({
      ok: false,
      error: '--body-file "assets/summary.md" is a symbolic link; Notifai reads only the file itself.',
    })
  })

  it.runIf(canLink)('refuses a form file reached through a linked folder', () => {
    const { home, repo } = machine()
    symlinkSync(path.join(home, '.ssh'), path.join(repo, 'forms'), 'dir')
    const read = readLocalText(repo, 'forms/id_ed25519', '--form')
    expect(read).toEqual({
      ok: false,
      error: `--form "forms/id_ed25519" goes through the symbolic link ${path.join(repo, 'forms')}; Notifai reads files only through real folders.`,
    })
  })

  it('refuses a folder and a file over the text limit', () => {
    const { repo } = machine()
    writeFileSync(path.join(repo, 'big.md'), Buffer.alloc(LOCAL_TEXT_MAX_BYTES + 1, 0x61))
    expect(readLocalText(repo, 'assets', '--body-file')).toEqual({ ok: false, error: '--body-file "assets" is not a regular file.' })
    expect(readLocalText(repo, 'big.md', '--body-file')).toEqual({
      ok: false,
      error: `--body-file "big.md" is larger than ${LOCAL_TEXT_MAX_BYTES} bytes.`,
    })
  })
})

describe('concurrent paths and hard links', () => {
  it.each(['text', 'image'] as const)('refuses a hard-linked private %s file', kind => {
    const { home, repo } = machine()
    const name = kind === 'text' ? 'summary.md' : 'shot.png'
    const privateFile = path.join(home, name)
    writeFileSync(privateFile, kind === 'text' ? KEY : PNG)
    linkSync(privateFile, path.join(repo, name))
    const read = kind === 'text' ? readLocalText(repo, name, '--body-file') : readLocalImage(repo, name, '--image')
    expect(read).toMatchObject({ ok: false, error: expect.stringContaining('hard link') })
  })

  // Junctions need no Windows symlink privilege, so this must run on Windows.
  const types = process.platform === 'win32' ? ['junction'] as const : ['dir'] as const
  it.each(types)('refuses a parent swapped to a %s before open', type => {
    const { home, repo } = machine()
    const assets = path.join(repo, 'assets')
    const privateDir = path.join(home, '.ssh')
    writeFileSync(path.join(assets, 'summary.md'), 'public summary')
    writeFileSync(path.join(privateDir, 'summary.md'), KEY)
    hooks.beforeOpen = () => {
      renameSync(assets, `${assets}-saved`)
      symlinkSync(privateDir, assets, type)
    }
    expect(readLocalText(repo, 'assets/summary.md', '--body-file').ok).toBe(false)
  })

  it.each(types)('refuses a private descriptor even if the %s is removed after open', type => {
    const { home, repo } = machine()
    const assets = path.join(repo, 'assets')
    const privateDir = path.join(home, '.ssh')
    writeFileSync(path.join(assets, 'shot.png'), PNG)
    writeFileSync(path.join(privateDir, 'shot.png'), Buffer.concat([PNG, Buffer.from('private picture')]))
    hooks.beforeOpen = () => {
      renameSync(assets, `${assets}-saved`)
      symlinkSync(privateDir, assets, type)
    }
    hooks.afterOpen = () => {
      rmSync(assets, { recursive: true, force: true })
      renameSync(`${assets}-saved`, assets)
    }
    expect(readLocalImage(repo, 'assets/shot.png', '--image').ok).toBe(false)
  })

  it('refuses a different regular file substituted before open', () => {
    const { home, repo } = machine()
    const file = path.join(repo, 'summary.md')
    writeFileSync(file, 'public summary')
    writeFileSync(path.join(home, 'private.md'), KEY)
    hooks.beforeOpen = () => {
      renameSync(file, `${file}-saved`)
      renameSync(path.join(home, 'private.md'), file)
    }
    expect(readLocalText(repo, 'summary.md', '--form').ok).toBe(false)
  })

  it.runIf(canLink)('refuses a repository folder link even when owned by root', () => {
    const { home, repo } = machine()
    const linked = path.join(repo, 'screens')
    symlinkSync(path.join(home, '.ssh'), linked, 'dir')
    hooks.rootOwnedLink = linked
    expect(readLocalText(repo, 'screens/id_ed25519', '--body-file').ok).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('reads a temporary Body through the exact /tmp alias', () => {
    const scratch = mkdtempSync('/tmp/notifai-alias-')
    try {
      writeFileSync(path.join(scratch, 'body.md'), 'temporary body')
      expect(readLocalText(process.cwd(), path.join(scratch, 'body.md'), '--body-file')).toEqual({ ok: true, text: 'temporary body' })
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })

  it.runIf(process.platform === 'darwin')('reads a regular file through the exact /etc alias', () => {
    expect(readLocalText(process.cwd(), '/etc/hosts', '--body-file')).toEqual({ ok: true, text: readFileSync('/etc/hosts', 'utf8') })
  })

  it.runIf(canLink)('refuses a linked cwd instead of erasing its link before inspection', () => {
    const { home, repo } = machine()
    const linked = path.join(home, 'workspace')
    symlinkSync(repo, linked, 'dir')
    writeFileSync(path.join(repo, 'body.md'), 'body')
    expect(readLocalText(linked, 'body.md', '--body-file').ok).toBe(false)
  })

  it.runIf(process.platform === 'darwin').each(['target', 'owner'] as const)('refuses a system alias with the wrong %s', change => {
    const scratch = mkdtempSync('/tmp/notifai-alias-refusal-')
    try {
      writeFileSync(path.join(scratch, 'body.md'), 'body')
      if (change === 'target') hooks.aliasTarget = 'private/var'
      else hooks.unownedAlias = '/tmp'
      expect(readLocalText(process.cwd(), path.join(scratch, 'body.md'), '--body-file').ok).toBe(false)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })


  it('retries unrelated directory activity while keeping the original file pinned', () => {
    const { repo } = machine()
    writeFileSync(path.join(repo, 'body.md'), 'body')
    hooks.beforeOpen = () => writeFileSync(path.join(repo, 'unrelated.md'), 'another job')
    expect(readLocalText(repo, 'body.md', '--body-file')).toEqual({ ok: true, text: 'body' })
  })

  it.runIf(process.platform === 'darwin')('accepts alias capitalization only when it names the same system link', () => {
    const scratch = mkdtempSync('/tmp/notifai-alias-case-')
    try {
      writeFileSync(path.join(scratch, 'body.md'), 'body')
      let same = false
      try { same = lstatSync('/TMP').ino === lstatSync('/tmp').ino } catch { /* case-sensitive filesystem */ }
      expect(readLocalText(process.cwd(), path.join(scratch.replace('/tmp/', '/TMP/'), 'body.md'), '--body-file').ok).toBe(same)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })


  it('refuses a repository cwd replaced by a link before validation starts', () => {
    const { home, repo } = machine()
    const privateDir = path.join(home, '.ssh')
    writeFileSync(path.join(privateDir, 'summary.md'), KEY)
    renameSync(repo, `${repo}-saved`)
    symlinkSync(privateDir, repo, process.platform === 'win32' ? 'junction' : 'dir')
    expect(readLocalText(repo, 'summary.md', '--body-file').ok).toBe(false)
  })

})
