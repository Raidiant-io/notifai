import type * as NodeFs from 'node:fs'
import { linkSync,mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll,afterEach,describe,expect,it,vi } from 'vitest'
import { readLocalImage,readLocalText } from './local-input.js'

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


  it('retries unrelated directory activity while keeping the original file pinned', () => {
    const { repo } = machine()
    writeFileSync(path.join(repo, 'body.md'), 'body')
    hooks.beforeOpen = () => writeFileSync(path.join(repo, 'unrelated.md'), 'another job')
    expect(readLocalText(repo, 'body.md', '--body-file')).toEqual({ ok: true, text: 'body' })
  })

})
