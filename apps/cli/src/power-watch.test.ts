import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { logindParser, logindWatch, parseLoginwindowLine, type PowerEvent } from './power-watch.js'

describe('the machine\'s shutdown signal', () => {
  it('reads loginwindow\'s posts: a shutdown or restart begins, or is cancelled; a logout alone is the User\'s', () => {
    expect(parseLoginwindowLine('event com.apple.system.loginwindow.shutdownInitiated 1792500159791')).toEqual({ kind: 'shutdown', name: 'com.apple.system.loginwindow.shutdownInitiated' })
    expect(parseLoginwindowLine('event com.apple.system.loginwindow.restartinitiated 1')?.kind).toBe('shutdown')
    expect(parseLoginwindowLine('event com.apple.system.loginwindow.likelyShutdown 1')?.kind).toBe('shutdown')
    expect(parseLoginwindowLine('event com.apple.system.loginwindow.logoutcancelled 1')?.kind).toBe('cancelled')
    expect(parseLoginwindowLine('event com.apple.system.loginwindow.logoutInitiated 1')?.kind).toBe('other')
    expect(parseLoginwindowLine('ready 1')).toBeNull()
  })

  it('reads logind\'s PrepareForShutdown as dbus-monitor and gdbus print it (the lines the Linux VM witness recorded)', () => {
    const parse = logindParser()
    expect(parse('signal time=1792501688.474807 sender=org.freedesktop.DBus -> destination=:1.20 serial=2 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameAcquired')).toBeNull()
    expect(parse('   string ":1.20"')).toBeNull()
    expect(parse('signal time=1792501688.474807 sender=:1.4 -> destination=(null destination) serial=333 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForShutdown')).toBeNull()
    expect(parse('   boolean true')?.kind).toBe('shutdown')
    expect(parse('   boolean false')).toBeNull()
    parse('signal time=1792501700.1 sender=:1.4 -> destination=(null destination) serial=340 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForShutdown')
    expect(parse('   boolean false')?.kind).toBe('cancelled')
    const gdbus = logindParser()
    expect(gdbus("/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdownWithMetadata (true, {'type': <'poweroff'>})")).toBeNull()
    expect(gdbus('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdown (true,)')?.kind).toBe('shutdown')
    expect(gdbus('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdown (false,)')?.kind).toBe('cancelled')
    expect(gdbus('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)')).toBeNull()
  })

  it('on Linux watches under a delay lock, lets it go once the hub has persisted, and takes it again after a cancellation', () => {
    const started: { command: string; args: string[]; child: ChildProcess & { out: PassThrough; killed_: boolean } }[] = []
    const fakeSpawn = ((command: string, args: string[]) => {
      const out = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdout: out, out, killed_: false, unref: () => undefined,
        kill: () => { child.killed_ = true; return true } }) as unknown as ChildProcess & { out: PassThrough; killed_: boolean }
      started.push({ command, args, child })
      return child
    }) as unknown as typeof spawn
    const events: PowerEvent[] = []
    const watch = logindWatch({ PATH: '/usr/bin' }, (event) => events.push(event), { available: () => true, spawnImpl: fakeSpawn })
    expect(watch.state()).toEqual({ source: 'logind', unavailable: null })
    expect(started[0]).toMatchObject({ command: 'systemd-inhibit' })
    expect(started[0]!.args).toEqual(expect.arrayContaining(['--what=shutdown', '--mode=delay', '--', 'dbus-monitor', '--system']))
    const signal = 'signal time=1 sender=:1.4 -> destination=(null destination) serial=1 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForShutdown\n'
    return (async () => {
      started[0]!.child.out.write(`${signal}   boolean true\n`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(events.map((event) => event.kind)).toEqual(['shutdown'])
      // Persisted: a plain monitor watches for a cancellation first, then the lock goes.
      watch.persisted()
      expect(started[1]).toMatchObject({ command: 'dbus-monitor' })
      expect(started[0]!.child.killed_).toBe(true)
      started[1]!.child.out.write(`${signal}   boolean false\n`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(events.map((event) => event.kind)).toEqual(['shutdown', 'cancelled'])
      expect(started[1]!.child.killed_).toBe(true)
      expect(started[2]).toMatchObject({ command: 'systemd-inhibit' })
      watch.stop()
      expect(started[2]!.child.killed_).toBe(true)
    })()
  })

  it('says why it cannot watch on Linux without the tools', () => {
    expect(logindWatch({}, () => undefined, { available: (tool) => tool !== 'systemd-inhibit' }).state()).toEqual({ source: null, unavailable: 'no-systemd-inhibit' })
    expect(logindWatch({}, () => undefined, { available: (tool) => tool !== 'dbus-monitor' }).state()).toEqual({ source: null, unavailable: 'no-dbus-monitor' })
  })
})
