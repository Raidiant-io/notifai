import { expect, it } from 'vitest'
import { WindowsPathInstallation, type UserPathValue, type UserPathRegistry } from './installation-windows-path.js'
const bin = 'C:\\Users\\User name\\.notifai\\bin'
function fixture(text: string, type: 0 | 1 | 2 = 2) {
  let value: UserPathValue = { type, hex: type ? Buffer.from(`${text}\0`, 'utf16le').toString('hex') : '' }, receipt: unknown = null
  const registry: UserPathRegistry = {
    read: () => ({ ...value }), write(expected, next) { expect(expected).toEqual(value); value = next; return { notified: false } },
  }
  const setup = new WindowsPathInstallation({ bin, registry, read: () => receipt, save: next => { receipt = next } })
  return { setup, registry, text: () => Buffer.from(value.hex, 'hex').toString('utf16le').slice(0, -1),
    value: () => value, edit: (text: string) => { value = { type: value.type, hex: Buffer.from(`${text}\0`, 'utf16le').toString('hex') } } }
}
it.each([1, 2] as const)('preserves raw User PATH entries and registry type %s across install/remove', type => {
  const original = '%USERPROFILE%\\Tools;C:\\Other;;'
  const f = fixture(original, type)
  expect(f.setup.configure()).toMatchObject({ ok: true, changed: true, notified: false, new_terminal_required: true })
  expect(f.text()).toBe(`${original};${bin}`)
  expect(f.value().type).toBe(type)
  expect(f.setup.configure().changed).toBe(false)
  f.edit(`${f.text()};C:\\UserAdded`)
  expect(f.setup.remove().ok).toBe(true)
  expect(f.text()).toBe(`${original};C:\\UserAdded`)
  expect(f.value().type).toBe(type)
})
it('does not claim an existing PATH entry and preserves a User-edited owned entry', () => {
  const preexisting = fixture(bin)
  expect(preexisting.setup.configure().changed).toBe(false)
  expect(preexisting.setup.remove().changed).toBe(false)
  expect(preexisting.text()).toBe(bin)
  const owned = fixture('', 0)
  owned.setup.configure(); owned.edit(bin.toUpperCase())
  expect(owned.setup.remove().ok).toBe(false)
  expect(owned.text()).toBe(bin.toUpperCase())
})
it('recovers a pending ownership receipt after a completed write with interrupted confirmation', () => {
  const f = fixture('C:\\Existing')
  const write = f.registry.write; let interrupted = true
  f.registry.write = (expected, next) => { const result = write(expected, next); if (interrupted) throw new Error('interrupted'); return result }
  expect(() => f.setup.configure()).toThrow('interrupted')
  interrupted = false
  expect(f.setup.configure()).toMatchObject({ ok: true, changed: false })
  expect(f.setup.remove().ok).toBe(true)
  expect(f.text()).toBe('C:\\Existing')
})
it('refuses oversized or malformed PATH values before recording ownership or writing', () => {
  let saves = 0, writes = 0
  const setup = new WindowsPathInstallation({ bin, registry: {
    read: () => ({ type: 2, hex: '000041000000' }), write: () => { writes++; return { notified: true } },
  }, read: () => null, save: () => { saves++ } })
  expect(() => setup.configure()).toThrow('Malformed')
  expect(saves).toBe(0); expect(writes).toBe(0)
})
