import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'

const PROFILE_NAMES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.bash_login', '.profile'] as const
type ProfileName = typeof PROFILE_NAMES[number]
interface Placement { name: ProfileName; block: string; state: 'pending' | 'installed' }
export interface ShellPathReceipt { schema: 1; profiles: Placement[] }
export interface ShellPathResult { ok: boolean; changed: boolean; profiles: ProfileName[]; conflicts: string[] }
const BEGIN = '# >>> notifai PATH >>>'
const END = '# <<< notifai PATH <<<'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Only the explicit installer calls this, under its installation lock. Receipt
 * storage belongs to Installation; no receipt can name an arbitrary file. */
export class ShellPathInstallation {
  private readonly block: string
  constructor(private readonly options: { home: string; bin: string; shell: string;
    read: () => unknown; save: (receipt: ShellPathReceipt) => void }) {
    if (!path.isAbsolute(options.home) || !path.isAbsolute(options.bin) || /[\0\r\n:]/.test(options.bin)) {
      throw new Error('Shell PATH requires an absolute directory without PATH delimiters')
    }
    const home = lstatSync(options.home)
    if (!home.isDirectory() || home.isSymbolicLink() || (typeof process.getuid === 'function' &&
        (home.uid !== process.getuid() || (home.mode & 0o022) !== 0))) throw new Error('Shell profile home is not safely owned')
    this.block = `\n${BEGIN}\ncase ":\${PATH-}:" in\n  *:${quote(options.bin)}:*) ;;\n  *) export PATH=${quote(options.bin)}\${PATH:+":$PATH"} ;;\nesac\n${END}\n`
  }
  private receipt(): ShellPathReceipt {
    const value = this.options.read() as Partial<ShellPathReceipt> | null
    if (value === null) return { schema: 1, profiles: [] }
    if (value?.schema !== 1 || !Array.isArray(value.profiles) || value.profiles.length > PROFILE_NAMES.length ||
        value.profiles.some(entry => !entry || !PROFILE_NAMES.includes(entry.name) || entry.block !== this.block || !['pending', 'installed'].includes(entry.state)) ||
        new Set(value.profiles.map(entry => entry.name)).size !== value.profiles.length) throw new Error('Invalid shell PATH ownership receipt')
    return { schema: 1, profiles: value.profiles.map(entry => ({ ...entry })) }
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
      throw new Error(`Cannot safely edit ${name}; preserve it and add the runtime directory to PATH manually`)
    }
    const text = readFileSync(file, 'utf8')
    return { text, expected: digest(text) }
  }
  private write(name: ProfileName, text: string, expected: string | null): void {
    atomicWriteFileSync(path.join(this.options.home, name), text, { expectedContentsSha256: expected,
      requireCurrentUserOwner: true, mode: 0o644, directoryMode: lstatSync(this.options.home).mode & 0o7777 })
  }
  private selected(): ProfileName[] {
    switch (path.basename(this.options.shell)) {
      case 'zsh': return ['.zshrc', '.zprofile']
      case 'bash': return ['.bashrc', (['.bash_profile', '.bash_login', '.profile'] as const)
        .find(name => existsSync(path.join(this.options.home, name))) ?? '.profile']
      case 'sh': case 'dash': return ['.profile']
      default: return []
    }
  }
  configure(): ShellPathResult {
    const receipt = this.receipt(), selected = this.selected(), conflicts: string[] = []
    let changed = false
    if (selected.length === 0) return { ok: false, changed, profiles: [], conflicts: ['unsupported_shell'] }
    for (const name of selected) {
      try {
        const snapshot = this.snapshot(name), entry = receipt.profiles.find(item => item.name === name)
        const count = snapshot.text.split(this.block).length - 1
        if (entry && count === 1) {
          if (entry.state !== 'installed') { entry.state = 'installed'; this.options.save(receipt) }
          continue
        }
        if (count !== 0 || snapshot.text.includes(BEGIN) || snapshot.text.includes(END) || entry?.state === 'installed') {
          conflicts.push(name); continue
        }
        const placement: Placement = entry ?? { name, block: this.block, state: 'pending' }
        if (!entry) receipt.profiles.push(placement)
        this.options.save(receipt) // Durable ownership intent precedes profile mutation.
        this.write(name, `${snapshot.text}${this.block}`, snapshot.expected)
        placement.state = 'installed'
        this.options.save(receipt)
        changed = true
      } catch { conflicts.push(name) }
    }
    return { ok: conflicts.length === 0, changed, profiles: selected, conflicts }
  }
  remove(): ShellPathResult {
    const receipt = this.receipt(), conflicts: string[] = [], names = receipt.profiles.map(entry => entry.name)
    let changed = false
    for (const entry of [...receipt.profiles]) {
      try {
        const snapshot = this.snapshot(entry.name), count = snapshot.text.split(entry.block).length - 1
        if (count === 1) {
          this.write(entry.name, snapshot.text.replace(entry.block, ''), snapshot.expected)
          changed = true
        } else if (count !== 0 || snapshot.text.includes(BEGIN) || snapshot.text.includes(END)) {
          conflicts.push(entry.name); continue
        }
        receipt.profiles = receipt.profiles.filter(item => item.name !== entry.name)
        this.options.save(receipt)
      } catch { conflicts.push(entry.name) }
    }
    return { ok: conflicts.length === 0, changed, profiles: names, conflicts }
  }
}
