import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NOTIFICATION_IMAGE_MAX_BYTES } from '@raidiant/notifai-protocol'
import { afterAll, describe, expect, it } from 'vitest'
import { LOCAL_TEXT_MAX_BYTES, readLocalImage, readLocalText } from './local-input.js'

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
