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
 *   folder, except the exact root-owned macOS `/tmp`, `/var` and `/etc` aliases;
 * - it is a regular file with one hard link, within a size limit; and
 * - an image's bytes are the JPEG, PNG or GIF its name says, so nothing else
 *   leaves under an image name.
 *
 * The opened descriptor must match the checked file, and the path is
 * rechecked before reading. Changed paths or files are refused.
 * `docs/TRUST.md` states the policy.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, type BigIntStats } from 'node:fs'
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

type PathEntry = { file: string; stat: BigIntStats }

const MACOS_ALIASES: Readonly<Record<string, string>> = {
  '/tmp': 'private/tmp',
  '/var': 'private/var',
  '/etc': 'private/etc',
}

/** Ownership alone proves nothing in a root-owned checkout or container. */
function systemAlias(file: string, stat: BigIntStats): boolean {
  const alias = file.toLowerCase()
  const target = MACOS_ALIASES[alias]
  if (process.platform !== 'darwin' || target === undefined || stat.uid !== 0n) return false
  if (readlinkSync(file) !== target || !sameIdentity(stat, lstatSync(alias, { bigint: true }))) return false
  // These exact aliases are rooted outside the repository. Do not require
  // the target to be unwritable: /private/tmp intentionally has mode 01777.
  return ['/', '/private', `/${target}`].every(folder => {
    const entry = lstatSync(folder, { bigint: true })
    return entry.isDirectory() && entry.uid === 0n
  })
}

/** Record every component, including the leaf, without following planted links. */
function checkedPath(absolute: string): { ok: true; entries: PathEntry[] } | { ok: false; link: string } {
  const { root } = path.parse(absolute)
  const parts = absolute.slice(root.length).split(path.sep).filter(part => part !== '')
  const entries: PathEntry[] = [{ file: root, stat: lstatSync(root, { bigint: true }) }]
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const stat = lstatSync(current, { bigint: true })
    if (stat.isSymbolicLink() && (index === parts.length - 1 || !systemAlias(current, stat))) {
      return { ok: false, link: current }
    }
    entries.push({ file: current, stat })
  }
  return { ok: true, entries }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  // A filesystem that does not expose file identity cannot establish this proof.
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

/** Recheck children before parents, including parent change times for ABA swaps. */
function unchangedPath(entries: PathEntry[]): boolean {
  return entries.toReversed().every(({ file, stat }) => {
    const now = lstatSync(file, { bigint: true })
    if (!sameIdentity(stat, now)) return false
    if (now.isSymbolicLink() && !systemAlias(file, now)) return false
    return stat.ctimeNs === now.ctimeNs
  })
}

/** Identity is pinned across retries; only directory change times may refresh. */
function samePath(before: PathEntry[], after: PathEntry[]): boolean {
  return before.length === after.length && before.every((entry, index) => {
    const next = after[index]!
    return entry.file === next.file && sameIdentity(entry.stat, next.stat)
      && (entry.stat.isDirectory() || entry.stat.ctimeNs === next.stat.ctimeNs)
  })
}

function readChecked(cwd: string, file: string, name: string, maxBytes: number): { ok: true; path: string; bytes: Buffer } | Refused {
  let anchor: PathEntry[] | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = readAttempt(cwd, file, name, maxBytes, anchor)
    if (!('retry' in result)) return result
    anchor = result.retry
    if (attempt === 2) return { ok: false, error: result.error }
  }
  return { ok: false, error: `${name} "${file}" cannot be checked.` }
}

function readAttempt(cwd: string, file: string, name: string, maxBytes: number, anchor?: PathEntry[]): { ok: true; path: string; bytes: Buffer } | Refused | (Refused & { retry: PathEntry[] }) {
  // The CLI supplies the OS working directory. Do not realpath a supplied cwd:
  // a repository could have replaced that directory with a planted link.
  const absolute = path.resolve(cwd, file)
  let entries: PathEntry[]
  try {
    const checked = checkedPath(absolute)
    if (!checked.ok) {
      return { ok: false, error: checked.link === absolute
        ? `${name} "${file}" is a symbolic link; Notifai reads only the file itself.`
        : `${name} "${file}" goes through the symbolic link ${checked.link}; Notifai reads files only through real folders.` }
    }
    entries = checked.entries
    if (anchor !== undefined && !samePath(anchor, entries)) {
      return { ok: false, error: `${name} "${file}" changed while its path was being checked; write a new file and try again.` }
    }
    const leaf = entries[entries.length - 1]!.stat
    if (!leaf.isFile()) return { ok: false, error: `${name} "${file}" is not a regular file.` }
    if (leaf.nlink > 1n) return { ok: false, error: `${name} "${file}" has more than one hard link; Notifai reads only files with a single name.` }
  } catch (error) {
    return { ok: false, error: (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? `${name} "${file}" does not exist.`
      : `${name} "${file}" cannot be checked.` }
  }
  let fd: number
  try {
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return { ok: false, error: `${name} "${file}" cannot be read.` }
  }
  try {
    const stat = fstatSync(fd, { bigint: true })
    const changed = (): Refused => ({ ok: false, error: `${name} "${file}" changed while its path was being checked; write a new file and try again.` })
    // O_NOFOLLOW protects only the basename and is unavailable on Windows.
    // Bind the descriptor to the original leaf before reading any bytes; a
    // post-open walk alone would miss a parent restored immediately after open.
    const pathChanged = (): Refused | (Refused & { retry: PathEntry[] }) => {
      const current = checkedPath(absolute)
      // A busy shared temp directory can change for an unrelated file. Retry
      // only with all original identities and the leaf's metadata still pinned.
      // A substituted file or folder never becomes a newly trusted input.
      return current.ok && samePath(entries, current.entries)
        ? { ...changed(), retry: anchor ?? entries }
        : changed()
    }
    if (!sameIdentity(entries[entries.length - 1]!.stat, stat)) return changed()
    if (!unchangedPath(entries)) return pathChanged()
    if (!stat.isFile()) return { ok: false, error: `${name} "${file}" is not a regular file.` }
    if (stat.nlink > 1n) return { ok: false, error: `${name} "${file}" has more than one hard link; Notifai reads only files with a single name.` }
    if (stat.size > BigInt(maxBytes)) return { ok: false, error: `${name} "${file}" is larger than ${maxBytes} bytes.` }
    // Bound allocation even if another process grows the file during the read.
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    const bytes = buffer.subarray(0, length)
    const after = fstatSync(fd, { bigint: true })
    if (!sameIdentity(stat, after) || after.nlink > 1n || after.ctimeNs !== stat.ctimeNs) return changed()
    if (!unchangedPath(entries)) return pathChanged()
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
