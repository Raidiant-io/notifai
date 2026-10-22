/**
 * Local files Notifai sends off this machine: `--image`, `--body-file`,
 * `--form` and the images an OpenCode form names.
 *
 * Their paths routinely come from an agent working in a cloned repository,
 * and a repository can commit a symbolic link to anywhere on the machine: an
 * `assets/preview.png` that is really `~/.ssh/id_ed25519`. The agent sees only
 * the innocent name, so the non-exfiltration rule it follows cannot help. The
 * CLI therefore reads such a file only as itself:
 *
 * - the file is never a symbolic link, and every folder on its path is a real
 *   folder, except a link the system owns (macOS's `/tmp` and `/var`), which a
 *   repository cannot create;
 * - it is a regular file within a size limit; and
 * - an image's bytes are the JPEG, PNG or GIF its name says, so nothing else
 *   leaves under an image name.
 *
 * The descriptor that was checked is the one read, so the file cannot be
 * swapped for a link in between. `docs/TRUST.md` states the policy.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { NOTIFICATION_IMAGE_MAX_BYTES } from '@raidiant/notifai-protocol'

/** A Body or form file; far above what the service accepts, far below anything costly. */
export const LOCAL_TEXT_MAX_BYTES = 1024 * 1024

export type LocalImageType = 'image/jpeg' | 'image/png' | 'image/gif'

const IMAGE_TYPES: Record<string, LocalImageType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
}

type Refused = { ok: false; error: string }

/** The first link on the path a repository could have planted, if any. */
function plantedLink(absolute: string): string | undefined {
  const { root } = path.parse(absolute)
  const parts = absolute.slice(root.length).split(path.sep).filter((part) => part !== '')
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    let stat
    try { stat = lstatSync(current) } catch { return undefined }
    if (!stat.isSymbolicLink()) continue
    // The file itself is never followed; a folder link only when the system
    // owns it. Windows reports every owner as 0, so there no link passes.
    const last = index === parts.length - 1
    if (last || process.platform === 'win32' || stat.uid !== 0) return current
  }
  return undefined
}

function readChecked(cwd: string, file: string, name: string, maxBytes: number): { ok: true; path: string; bytes: Buffer } | Refused {
  // A relative path starts from where the working folder really is, so a
  // working folder reached through the User's own link still reads.
  const absolute = path.resolve(cwd, file)
  let real = absolute
  if (!path.isAbsolute(file)) {
    try { real = path.resolve(realpathSync(cwd), file) } catch { /* a missing cwd resolves as written */ }
  }
  const link = plantedLink(real)
  if (link === real) return { ok: false, error: `${name} "${file}" is a symbolic link; Notifai reads only the file itself.` }
  if (link !== undefined) {
    return { ok: false, error: `${name} "${file}" goes through the symbolic link ${link}; Notifai reads files only through real folders.` }
  }
  try {
    if (!lstatSync(real).isFile()) return { ok: false, error: `${name} "${file}" is not a regular file.` }
  } catch {
    return { ok: false, error: `${name} "${file}" does not exist.` }
  }
  let fd: number
  try {
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return { ok: false, error: `${name} "${file}" cannot be read.` }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { ok: false, error: `${name} "${file}" is not a regular file.` }
    if (stat.size > maxBytes) return { ok: false, error: `${name} "${file}" is larger than ${maxBytes} bytes.` }
    const bytes = readFileSync(fd)
    if (bytes.byteLength > maxBytes) return { ok: false, error: `${name} "${file}" is larger than ${maxBytes} bytes.` }
    return { ok: true, path: absolute, bytes }
  } catch {
    return { ok: false, error: `${name} "${file}" cannot be read.` }
  } finally {
    closeSync(fd)
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte)
}

function isImage(bytes: Uint8Array, type: LocalImageType): boolean {
  if (type === 'image/png') return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (type === 'image/jpeg') return startsWith(bytes, [0xff, 0xd8, 0xff])
  const head = Buffer.from(bytes.subarray(0, 6)).toString('latin1')
  return head === 'GIF87a' || head === 'GIF89a'
}

/** A local image to upload, read under the policy above. `name` prefixes every refusal. */
export function readLocalImage(
  cwd: string,
  file: string,
  name: string,
): { ok: true; path: string; bytes: Uint8Array; mediaType: LocalImageType } | Refused {
  const mediaType = IMAGE_TYPES[path.extname(file).toLowerCase()]
  if (mediaType === undefined) return { ok: false, error: `${name} "${file}" must be a JPEG, PNG or GIF file.` }
  const read = readChecked(cwd, file, name, NOTIFICATION_IMAGE_MAX_BYTES)
  if (!read.ok) return read
  const bytes = new Uint8Array(read.bytes)
  if (!isImage(bytes, mediaType)) {
    const label = mediaType === 'image/jpeg' ? 'JPEG' : mediaType.slice('image/'.length).toUpperCase()
    return { ok: false, error: `${name} "${file}" is not the ${label} image its name says.` }
  }
  return { ok: true, path: read.path, bytes, mediaType }
}

/** A local Body or form file, read under the policy above; stdin (`-`) is the caller's. */
export function readLocalText(cwd: string, file: string, name: string): { ok: true; text: string } | Refused {
  const read = readChecked(cwd, file, name, LOCAL_TEXT_MAX_BYTES)
  return read.ok ? { ok: true, text: read.bytes.toString('utf8') } : read
}
