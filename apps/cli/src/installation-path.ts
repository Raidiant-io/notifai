import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { canonicalPath } from './local-path.js'

const PROFILE_NAMES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.config/fish/conf.d/notifai.fish'] as const
type ProfileName = typeof PROFILE_NAMES[number]
const FISH: ProfileName = '.config/fish/conf.d/notifai.fish'
interface Placement { name: ProfileName; block: string; state: 'pending' | 'installed' }
export interface ShellPathReceipt { schema: 2; directory: string; command: 'pending' | 'installed' | null; profiles: Placement[] }
export interface ShellPathResult {
  ok: boolean
  changed: boolean
  /** The owned `notifai` entry in the User command directory. */
  command: string | null
  directory: string | null
  /** Whether the installing environment already searches that directory. */
  on_path: boolean
  profiles: string[]
  conflicts: string[]
  /** Set when no supported startup file applies: the one line the User adds. */
  manual?: string
}
const BEGIN = '# >>> notifai PATH >>>'
const END = '# <<< notifai PATH <<<'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const fishQuote = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
const usableDirectory = (value: string) => path.isAbsolute(value) && !/[\0\r\n:]/.test(value)

/**
 * The User's command directory, as the XDG Base Directory convention names it:
 * `$XDG_BIN_HOME` when set, otherwise `~/.local/bin`. Common Linux login shells
 * already search it; Claude Code's native installer, uv and pipx use it too.
 */
export function userCommandDirectory(home: string, env: NodeJS.ProcessEnv): string {
  const configured = env['XDG_BIN_HOME']
  return configured && usableDirectory(configured) ? path.normalize(configured) : path.join(home, '.local', 'bin')
}

/**
 * Makes the stable command reachable without per-shell knowledge where
 * possible: an owned link in the User command directory. Only when that
 * directory is not already searched does it add one marked block to the
 * login shell's own startup files, the way rustup and uv do. Any other shell
 * gets the exact line to add, and setup continues.
 *
 * Only the explicit installer calls this, under its installation lock. Receipt
 * storage belongs to Installation; no receipt can name an arbitrary file.
 */
export class ShellPathInstallation {
  constructor(private readonly options: { home: string; bin: string; shell: string; env?: NodeJS.ProcessEnv;
    read: () => unknown; save: (receipt: ShellPathReceipt) => void }) {
    if (!path.isAbsolute(options.home) || !usableDirectory(options.bin)) {
      throw new Error('Shell PATH requires an absolute directory without PATH delimiters')
    }
    const home = lstatSync(options.home)
    if (!home.isDirectory() || home.isSymbolicLink() || (typeof process.getuid === 'function' &&
        (home.uid !== process.getuid() || (home.mode & 0o022) !== 0))) throw new Error('Shell profile home is not safely owned')
  }
  private get target(): string { return path.join(this.options.bin, 'notifai') }
  private block(name: ProfileName, directory: string): string {
    if (name === FISH) {
      return `${BEGIN}\nif not contains -- ${fishQuote(directory)} $PATH\n    set -gx PATH ${fishQuote(directory)} $PATH\nend\n${END}\n`
    }
    return `\n${BEGIN}\ncase ":\${PATH-}:" in\n  *:${quote(directory)}:*) ;;\n  *) export PATH=${quote(directory)}\${PATH:+":$PATH"} ;;\nesac\n${END}\n`
  }
  private receipt(): ShellPathReceipt | null {
    const value = this.options.read() as Partial<ShellPathReceipt> | null
    if (value === null) return null
    if (value?.schema !== 2 || typeof value.directory !== 'string' || !usableDirectory(value.directory) ||
        ![null, 'pending', 'installed'].includes(value.command ?? null) ||
        !Array.isArray(value.profiles) || value.profiles.length > PROFILE_NAMES.length ||
        value.profiles.some(entry => !entry || !PROFILE_NAMES.includes(entry.name) || entry.block !== this.block(entry.name, value.directory!) ||
          !['pending', 'installed'].includes(entry.state)) ||
        new Set(value.profiles.map(entry => entry.name)).size !== value.profiles.length) throw new Error('Invalid shell PATH ownership receipt')
    return { schema: 2, directory: value.directory, command: value.command ?? null, profiles: value.profiles.map(entry => ({ ...entry })) }
  }
  private snapshot(name: ProfileName): { text: string; expected: string | null } {
    const file = path.join(this.options.home, name)
    let stat
    try { stat = lstatSync(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', expected: null }
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 ||
        (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) {
      throw new Error(`Cannot safely edit ${name}; preserve it and add the command directory to PATH manually`)
    }
    const text = readFileSync(file, 'utf8')
    return { text, expected: digest(text) }
  }
  private write(name: ProfileName, text: string, expected: string | null): void {
    const file = path.join(this.options.home, name)
    if (name === FISH) mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
    atomicWriteFileSync(file, text, { expectedContentsSha256: expected,
      requireCurrentUserOwner: true, mode: 0o644, directoryMode: lstatSync(path.dirname(file)).mode & 0o7777 })
  }
  private selected(): ProfileName[] {
    switch (path.basename(this.options.shell)) {
      // A custom ZDOTDIR moves zsh's startup files; their owner adds the line.
      case 'zsh': return this.options.env?.['ZDOTDIR'] ? [] : ['.zshrc', '.zprofile']
      case 'bash': return ['.bashrc', (['.bash_profile', '.bash_login', '.profile'] as const)
        .find(name => existsSync(path.join(this.options.home, name))) ?? '.profile']
      case 'sh': case 'dash': return ['.profile']
      case 'fish': return [FISH]
      default: return []
    }
  }
  private searched(directory: string): boolean {
    const wanted = canonicalPath(directory)
    return (this.options.env?.['PATH'] ?? '').split(':').some(entry => entry !== '' && path.isAbsolute(entry) && canonicalPath(entry) === wanted)
  }
  /** The owned link, or the reason none can be placed there. */
  private placeCommand(receipt: ShellPathReceipt): { changed: boolean; conflict?: string } {
    const link = path.join(receipt.directory, 'notifai')
    let existing
    try { existing = lstatSync(link) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { changed: false, conflict: link }
    }
    if (existing) {
      if (existing.isSymbolicLink() && readlinkSync(link) === this.target) {
        if (receipt.command !== 'installed') { receipt.command = 'installed'; this.options.save(receipt) }
        return { changed: false }
      }
      return { changed: false, conflict: link } // Never replace another program's command.
    }
    mkdirSync(receipt.directory, { recursive: true, mode: 0o755 })
    const directory = statSync(receipt.directory)
    if (!directory.isDirectory() || (typeof process.getuid === 'function' &&
        (directory.uid !== process.getuid() || (directory.mode & 0o022) !== 0))) return { changed: false, conflict: receipt.directory }
    receipt.command = 'pending'
    this.options.save(receipt) // Durable ownership intent precedes the link.
    symlinkSync(this.target, link)
    receipt.command = 'installed'
    this.options.save(receipt)
    return { changed: true }
  }
  configure(): ShellPathResult {
    const prior = this.receipt()
    const receipt: ShellPathReceipt = prior ?? { schema: 2, directory: userCommandDirectory(this.options.home, this.options.env ?? {}), command: null, profiles: [] }
    const command = path.join(receipt.directory, 'notifai'), conflicts: string[] = []
    let changed = false
    try {
      const placed = this.placeCommand(receipt)
      changed = placed.changed
      if (placed.conflict) conflicts.push(placed.conflict)
    } catch { conflicts.push(command) }
    const base = { command: conflicts.length ? null : command, directory: receipt.directory }
    if (this.searched(receipt.directory)) return { ok: conflicts.length === 0, changed, ...base, on_path: true, profiles: [], conflicts }
    const selected = this.selected()
    if (selected.length === 0) {
      return { ok: conflicts.length === 0, changed, ...base, on_path: false, profiles: [], conflicts,
        manual: `Add ${receipt.directory} to PATH in your shell's startup file.` }
    }
    for (const name of selected) {
      try {
        const block = this.block(name, receipt.directory)
        const snapshot = this.snapshot(name), entry = receipt.profiles.find(item => item.name === name)
        const count = snapshot.text.split(block).length - 1
        if (entry && count === 1) {
          if (entry.state !== 'installed') { entry.state = 'installed'; this.options.save(receipt) }
          continue
        }
        if (count !== 0 || snapshot.text.includes(BEGIN) || snapshot.text.includes(END) || entry?.state === 'installed') {
          conflicts.push(name); continue
        }
        const placement: Placement = entry ?? { name, block, state: 'pending' }
        if (!entry) receipt.profiles.push(placement)
        this.options.save(receipt) // Durable ownership intent precedes profile mutation.
        this.write(name, `${snapshot.text}${block}`, snapshot.expected)
        placement.state = 'installed'
        this.options.save(receipt)
        changed = true
      } catch { conflicts.push(name) }
    }
    return { ok: conflicts.length === 0, changed, ...base, on_path: false, profiles: selected, conflicts }
  }
  remove(): ShellPathResult {
    const receipt = this.receipt()
    if (receipt === null) return { ok: true, changed: false, command: null, directory: null, on_path: false, profiles: [], conflicts: [] }
    const conflicts: string[] = [], names = receipt.profiles.map(entry => entry.name), link = path.join(receipt.directory, 'notifai')
    let changed = false
    if (receipt.command !== null) {
      try {
        let existing
        try { existing = lstatSync(link) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const owned = existing?.isSymbolicLink() === true && readlinkSync(link) === this.target
        if (existing && !owned) conflicts.push(link) // A replaced entry is the User's now.
        else {
          if (owned) { unlinkSync(link); changed = true }
          receipt.command = null
          this.options.save(receipt)
        }
      } catch { conflicts.push(link) }
    }
    for (const entry of [...receipt.profiles]) {
      try {
        const snapshot = this.snapshot(entry.name), count = snapshot.text.split(entry.block).length - 1
        if (count === 1) {
          const rest = snapshot.text.replace(entry.block, '')
          if (entry.name === FISH && rest === '') unlinkSync(path.join(this.options.home, entry.name))
          else this.write(entry.name, rest, snapshot.expected)
          changed = true
        } else if (count !== 0 || snapshot.text.includes(BEGIN) || snapshot.text.includes(END)) {
          conflicts.push(entry.name); continue
        }
        receipt.profiles = receipt.profiles.filter(item => item.name !== entry.name)
        this.options.save(receipt)
      } catch { conflicts.push(entry.name) }
    }
    return { ok: conflicts.length === 0, changed, command: link, directory: receipt.directory, on_path: false, profiles: names, conflicts }
  }
}
