import { execFileSync } from 'node:child_process'
import path from 'node:path'

export interface UserPathValue { type: 0 | 1 | 2; hex: string }
export interface UserPathRegistry {
  read(): UserPathValue
  write(expected: UserPathValue, next: UserPathValue): { notified: boolean }
}
export interface WindowsPathReceipt { schema: 1; entry: string; state: 'pending' | 'installed' }
export interface WindowsPathResult { ok: boolean; changed: boolean; conflicts: string[]; notified?: boolean; new_terminal_required: true }
function decode(value: UserPathValue): string {
  if (!value || ![0, 1, 2].includes(value.type) || typeof value.hex !== 'string' || value.hex.length > 131072 ||
      !/^(?:[a-f0-9]{4})*$/.test(value.hex)) throw new Error('Invalid User PATH registry value')
  if (value.type === 0) {
    if (value.hex !== '') throw new Error('Invalid absent User PATH')
    return ''
  }
  const bytes = Buffer.from(value.hex, 'hex'), text = bytes.toString('utf16le')
  if (!text.endsWith('\0') || text.slice(0, -1).includes('\0') || Buffer.from(text, 'utf8').toString('utf8') !== text) throw new Error('Malformed User PATH string')
  return text.slice(0, -1)
}
function encode(text: string, type: UserPathValue['type']): UserPathValue {
  const value = { type: type || 2, hex: Buffer.from(`${text}\0`, 'utf16le').toString('hex') } as UserPathValue
  decode(value)
  return value
}
export function nativeUserPathRegistry(launcher = path.join(path.dirname(process.execPath), 'notifai.exe')): UserPathRegistry {
  const run = (operation: string, input?: string): unknown => JSON.parse(execFileSync(launcher, [operation], {
    ...(input === undefined ? {} : { input }), encoding: 'utf8', windowsHide: true, timeout: 15_000,
    maxBuffer: 256 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  }))
  return {
    read() { const value = run('--internal-user-path-read') as UserPathValue; decode(value); return value },
    write(expected, next) {
      decode(expected); decode(next)
      const result = run('--internal-user-path-write', `${expected.type} ${expected.hex}\n${next.type} ${next.hex}\n`) as { ok?: boolean; notified?: boolean }
      if (result?.ok !== true || typeof result.notified !== 'boolean') throw new Error('User PATH write was not verified')
      return { notified: result.notified }
    },
  }
}

/** Called under the installation lock. Only literal owned entries are removed.
 * The native adapter checks expected raw bytes and verifies readback, but Windows
 * provides no per-value CAS against other software editing the same registry value. */
export class WindowsPathInstallation {
  constructor(private readonly options: { bin: string; registry: UserPathRegistry;
    read: () => unknown; save: (receipt: WindowsPathReceipt | null) => void }) {
    if (!path.win32.isAbsolute(options.bin) || /[\0\r\n;"%]/.test(options.bin) || Buffer.from(options.bin, 'utf8').toString('utf8') !== options.bin) {
      throw new Error('Windows User PATH requires an absolute directory without delimiters or expansion syntax')
    }
  }
  private receipt(): WindowsPathReceipt | null {
    const value = this.options.read() as Partial<WindowsPathReceipt> | null
    if (value === null) return null
    if (value?.schema !== 1 || value.entry !== this.options.bin || !['pending', 'installed'].includes(value.state ?? '')) {
      throw new Error('Invalid Windows PATH ownership receipt')
    }
    return value as WindowsPathReceipt
  }
  configure(): WindowsPathResult {
    const receipt = this.receipt(), before = this.options.registry.read(), text = decode(before), entries = text.split(';')
    const equal = entries.filter(entry => entry.toLowerCase() === this.options.bin.toLowerCase())
    if (equal.length) {
      if (receipt && (equal.length !== 1 || equal[0] !== this.options.bin)) return this.conflict()
      if (receipt?.state === 'pending') this.options.save({ ...receipt, state: 'installed' })
      return { ok: true, changed: false, conflicts: [], new_terminal_required: true }
    }
    if (receipt?.state === 'installed') return this.conflict() // Preserve a User-removed entry.
    this.options.save({ schema: 1, entry: this.options.bin, state: 'pending' })
    const next = encode(text ? `${text};${this.options.bin}` : this.options.bin, before.type)
    const { notified } = this.options.registry.write(before, next)
    this.options.save({ schema: 1, entry: this.options.bin, state: 'installed' })
    return { ok: true, changed: true, conflicts: [], notified, new_terminal_required: true }
  }
  private conflict(): WindowsPathResult {
    return { ok: false, changed: false, conflicts: ['User PATH ownership changed'], new_terminal_required: true }
  }
  remove(): WindowsPathResult {
    const receipt = this.receipt()
    if (!receipt) return { ok: true, changed: false, conflicts: [], new_terminal_required: true }
    const before = this.options.registry.read(), text = decode(before), entries = text.split(';')
    const indexes = entries.flatMap((entry, index) => entry.toLowerCase() === this.options.bin.toLowerCase() ? [index] : [])
    if (indexes.length === 0) {
      this.options.save(null)
      return { ok: true, changed: false, conflicts: [], new_terminal_required: true }
    }
    if (indexes.length !== 1 || entries[indexes[0]!] !== this.options.bin) return this.conflict()
    entries.splice(indexes[0]!, 1)
    const { notified } = this.options.registry.write(before, encode(entries.join(';'), before.type))
    this.options.save(null)
    return { ok: true, changed: true, conflicts: [], notified, new_terminal_required: true }
  }
}
