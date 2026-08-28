import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  FileStore,
  KeychainStore,
  WindowsDpapiStore,
  defaultCredentialStore,
  windowsDpapiOperation,
  type MachineCredential,
  type ProcessRunner,
  type RunCommandSpec,
} from './credentials.js'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'notifai-cred-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const SAMPLE: MachineCredential = {
  machineId: 'mach_fixture',
  secret: 'fixture-secret',
  baseUrl: 'https://example.test',
  machineName: 'fixture-machine',
}

const OTHER: MachineCredential = {
  machineId: 'mach_other',
  secret: 'other-secret',
  baseUrl: 'https://other.test',
  machineName: 'other-machine',
}

function sandbox(name: string): {
  env: NodeJS.ProcessEnv
  local: string
  roaming: string
  config: string
} {
  const root = path.join(tmp, name)
  const local = path.join(root, 'local')
  const roaming = path.join(root, 'roaming')
  const config = path.join(root, 'config')
  mkdirSync(local, { recursive: true })
  mkdirSync(roaming, { recursive: true })
  mkdirSync(config, { recursive: true })
  return {
    local,
    roaming,
    config,
    env: {
      LOCALAPPDATA: local,
      APPDATA: roaming,
      XDG_CONFIG_HOME: config,
      SystemRoot: 'C:\\Windows',
    },
  }
}

function writeRaw(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

function mockDpapi(options: { failProtect?: boolean; failUnprotect?: boolean } = {}): {
  runner: ProcessRunner
  calls: RunCommandSpec[]
} {
  const vault = new Map<string, string>()
  const calls: RunCommandSpec[] = []
  const runner: ProcessRunner = {
    run(spec) {
      calls.push({
        command: spec.command,
        args: spec.args,
        input: spec.input,
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      })
      const operation = windowsDpapiOperation(spec.args)
      if (operation === 'protect') {
        if (options.failProtect) return { status: 1, stdout: Buffer.alloc(0) }
        const token = Buffer.from(`dpapi:${vault.size}`, 'utf8').toString('base64')
        vault.set(token, spec.input.toString('utf8'))
        return { status: 0, stdout: Buffer.from(token, 'utf8') }
      }
      if (operation === 'unprotect') {
        if (options.failUnprotect) return { status: 1, stdout: Buffer.alloc(0) }
        const token = spec.input.toString('utf8').trim()
        const plain = vault.get(token)
        if (plain === undefined) return { status: 1, stdout: Buffer.alloc(0) }
        return { status: 0, stdout: Buffer.from(plain, 'utf8') }
      }
      return { status: 1, stdout: Buffer.alloc(0) }
    },
  }
  return { runner, calls }
}

function assertNoSecretInArgs(calls: RunCommandSpec[]): void {
  for (const call of calls) {
    const argv = [call.command, ...call.args].join('\0')
    for (const credential of [SAMPLE, OTHER]) {
      for (const value of Object.values(credential)) expect(argv).not.toContain(value)
      expect(argv).not.toContain(JSON.stringify(credential))
    }
    expect(argv).not.toContain('machineId')
  }
}

describe('defaultCredentialStore', () => {
  it('selects the DPAPI store on win32', () => {
    const { env } = sandbox('default-win32')
    const store = defaultCredentialStore(env, { platform: 'win32', run: mockDpapi().runner })
    expect(store).toBeInstanceOf(WindowsDpapiStore)
    expect(store.describe()).toMatch(/Windows DPAPI current-user/)
    expect(store.describe()).toContain(path.join(env.LOCALAPPDATA!, 'notifai', 'credentials.dpapi'))
  })

  it('keeps the explicit file escape hatch on win32 under APPDATA', () => {
    const { env } = sandbox('default-file-win32')
    const store = defaultCredentialStore(
      { ...env, NOTIFAI_CREDENTIALS: 'file', XDG_CONFIG_HOME: undefined },
      { platform: 'win32' },
    )
    expect(store).toBeInstanceOf(FileStore)
    expect(store.describe()).toContain(path.join(env.APPDATA!, 'notifai', 'credentials.json'))
    expect(store.describe()).toMatch(/plaintext file/)
    expect(store.describe()).toMatch(/POSIX mode bits are not protection on NTFS/)
    expect(store.describe()).not.toMatch(/0600/)
  })

  it('preserves macOS Keychain when available', () => {
    const store = defaultCredentialStore({}, { platform: 'darwin', keychainAvailable: true })
    expect(store.describe()).toBe('macOS Keychain (io.notifai.cli)')
  })

  it('falls back to the 0600 file store on linux', () => {
    const { env } = sandbox('default-linux')
    const store = defaultCredentialStore(env, { platform: 'linux' })
    expect(store).toBeInstanceOf(FileStore)
    expect(store.describe()).toMatch(/plaintext file/)
    expect(store.describe()).toMatch(/mode 0600/)
    expect(store.describe()).not.toMatch(/NTFS/)
  })

  it('uses the file store on macOS when Keychain is unavailable', () => {
    const { env } = sandbox('default-darwin-file')
    const store = defaultCredentialStore(env, { platform: 'darwin', keychainAvailable: false })
    expect(store).toBeInstanceOf(FileStore)
    expect(store.describe()).toMatch(/mode 0600/)
  })
})

describe('FileStore', () => {
  it('saves, loads, overwrites, and clears atomically', () => {
    const { env } = sandbox('file-roundtrip')
    const store = new FileStore(env, { platform: 'linux' })
    expect(store.load()).toBeNull()
    store.save(SAMPLE)
    const file = path.join(env.XDG_CONFIG_HOME!, 'notifai', 'credentials.json')
    expect(existsSync(file)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      format: 'notifai.machine-credential.v1',
      ...SAMPLE,
    })
    expect(store.load()).toEqual(SAMPLE)
    store.save(OTHER)
    expect(store.load()).toEqual(OTHER)
    store.clear()
    expect(existsSync(file)).toBe(false)
    expect(store.load()).toBeNull()
  })

  it('treats malformed JSON as missing', () => {
    const { env } = sandbox('file-malformed')
    const file = path.join(env.XDG_CONFIG_HOME!, 'notifai', 'credentials.json')
    writeRaw(file, '{not-json')
    expect(new FileStore(env).load()).toBeNull()
  })

  it('treats incomplete objects as missing', () => {
    const { env } = sandbox('file-incomplete')
    const file = path.join(env.XDG_CONFIG_HOME!, 'notifai', 'credentials.json')
    writeRaw(file, `${JSON.stringify({ machineId: 'mach_fixture' })}\n`)
    expect(new FileStore(env).load()).toBeNull()
  })

  it('reads the unversioned v1 shape while making every new save explicit', () => {
    const { env } = sandbox('file-unversioned-v1')
    const file = path.join(env.XDG_CONFIG_HOME!, 'notifai', 'credentials.json')
    writeRaw(file, `${JSON.stringify(SAMPLE)}\n`)
    const store = new FileStore(env)
    expect(store.load()).toEqual(SAMPLE)
    store.save(SAMPLE)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      format: 'notifai.machine-credential.v1',
    })
  })

  it('creates the credential directory mode 0700 on POSIX', () => {
    if (process.platform === 'win32') return
    const { env } = sandbox('file-dir-mode')
    const store = new FileStore(env, { platform: 'linux' })
    store.save(SAMPLE)
    const dir = path.join(env.XDG_CONFIG_HOME!, 'notifai')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('tightens an existing world-readable credential directory on POSIX', () => {
    if (process.platform === 'win32') return
    const { env } = sandbox('file-dir-chmod')
    const dir = path.join(env.XDG_CONFIG_HOME!, 'notifai')
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    chmodSync(dir, 0o755)
    expect(statSync(dir).mode & 0o777).toBe(0o755)
    const store = new FileStore(env, { platform: 'linux' })
    store.save(SAMPLE)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('does not interpret or erase a credential from a future format epoch', () => {
    const { env } = sandbox('file-future-format')
    const file = path.join(env.XDG_CONFIG_HOME!, 'notifai', 'credentials.json')
    const future = `${JSON.stringify({ format: 'notifai.machine-credential.v2', ...SAMPLE })}\n`
    writeRaw(file, future)
    expect(new FileStore(env).load()).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe(future)
  })
})

describe('KeychainStore', () => {
  it('sends the serialized credential through stdin and never process argv', () => {
    const calls: RunCommandSpec[] = []
    const runner: ProcessRunner = {
      run(spec) {
        calls.push(spec)
        return { status: 0, stdout: Buffer.alloc(0) }
      },
    }
    const store = new KeychainStore({ run: runner })
    store.save(SAMPLE)
    store.save(OTHER)

    expect(calls).toHaveLength(2)
    for (const [index, call] of calls.entries()) {
      expect(call.command).toBe('security')
      expect(call.args).toEqual(['-q', '-i'])
      expect(call.timeoutMs).toBe(15_000)
      expect(call.input.toString('ascii')).toMatch(
        /^add-generic-password -U -s io\.notifai\.cli -a machine -X [0-9a-f]+\n$/,
      )
      const encoded = call.input.toString('ascii').match(/-X ([0-9a-f]+)\n$/)?.[1]
      expect(encoded).toBeDefined()
      expect(JSON.parse(Buffer.from(encoded!, 'hex').toString('utf8'))).toEqual({
        format: 'notifai.machine-credential.v1',
        ...(index === 0 ? SAMPLE : OTHER),
      })
      expect(call.input.toString('utf8')).not.toContain(index === 0 ? SAMPLE.secret : OTHER.secret)
    }
    assertNoSecretInArgs(calls)
  })

  it('fails closed when the Keychain helper rejects the write', () => {
    const runner: ProcessRunner = {
      run() {
        return { status: 1, stdout: Buffer.alloc(0) }
      },
    }
    expect(() => new KeychainStore({ run: runner }).save(SAMPLE)).toThrow(
      /Keychain credential save failed/,
    )
  })
})

describe('WindowsDpapiStore', () => {
  it('round-trips through real Windows CurrentUser DPAPI without plaintext on disk', () => {
    if (process.platform !== 'win32') return

    const local = path.join(tmp, 'real dpapi & Ω', 'local app data')
    mkdirSync(local, { recursive: true })
    const env = { ...process.env, LOCALAPPDATA: local }
    const store = new WindowsDpapiStore(env)
    store.save(SAMPLE)

    const file = path.join(local, 'notifai', 'credentials.dpapi')
    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain(SAMPLE.secret)
    expect(onDisk).not.toContain(SAMPLE.machineId)
    expect(new WindowsDpapiStore(env).load()).toEqual(SAMPLE)

    store.clear()
    expect(existsSync(file)).toBe(false)
  })

  it('protects under LOCALAPPDATA and never writes roaming or config trees', () => {
    const { env, roaming, config } = sandbox('dpapi-location')
    const { runner, calls } = mockDpapi()
    const store = new WindowsDpapiStore(env, { run: runner })
    store.save(SAMPLE)
    const file = path.join(env.LOCALAPPDATA!, 'notifai', 'credentials.dpapi')
    expect(existsSync(file)).toBe(true)
    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain(SAMPLE.secret)
    expect(onDisk).not.toContain(SAMPLE.machineId)
    expect(JSON.parse(onDisk)).toMatchObject({ format: 'notifai.dpapi.current-user.v1' })
    expect(readdirSync(roaming, { recursive: true })).toEqual([])
    expect(existsSync(config) ? readdirSync(config, { recursive: true }) : []).toEqual([])
    expect(store.load()).toEqual(SAMPLE)
    expect(store.describe()).toBe(`Windows DPAPI current-user (${file})`)
    expect(calls[0]?.command).toMatch(/powershell\.exe$/i)
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']),
    )
    assertNoSecretInArgs(calls)
  })

  it('overwrites and clears the protected blob', () => {
    const { env } = sandbox('dpapi-overwrite')
    const { runner, calls } = mockDpapi()
    const store = new WindowsDpapiStore(env, { run: runner })
    store.save(SAMPLE)
    store.save(OTHER)
    expect(store.load()).toEqual(OTHER)
    store.clear()
    expect(store.load()).toBeNull()
    expect(
      existsSync(path.join(env.LOCALAPPDATA!, 'notifai', 'credentials.dpapi')),
    ).toBe(false)
    assertNoSecretInArgs(calls)
  })

  it('returns null for missing, malformed, and corrupt envelopes', () => {
    const { env } = sandbox('dpapi-corrupt')
    const { runner } = mockDpapi()
    const store = new WindowsDpapiStore(env, { run: runner })
    expect(store.load()).toBeNull()
    const file = path.join(env.LOCALAPPDATA!, 'notifai', 'credentials.dpapi')
    writeRaw(file, 'not-json')
    expect(store.load()).toBeNull()
    writeRaw(file, `${JSON.stringify({ format: 'unknown', data: 'AAAA' })}\n`)
    expect(store.load()).toBeNull()
    writeRaw(
      file,
      `${JSON.stringify({ format: 'notifai.dpapi.current-user.v1', data: '@@@' })}\n`,
    )
    expect(store.load()).toBeNull()
  })

  it('leaves the existing blob in place when protection fails', () => {
    const { env } = sandbox('dpapi-protect-fail')
    const good = mockDpapi()
    const store = new WindowsDpapiStore(env, { run: good.runner })
    store.save(SAMPLE)
    const failing = mockDpapi({ failProtect: true })
    const broken = new WindowsDpapiStore(env, { run: failing.runner })
    expect(() => broken.save(OTHER)).toThrow(/Windows credential protection failed/)
    expect(store.load()).toEqual(SAMPLE)
    const onDisk = readFileSync(path.join(env.LOCALAPPDATA!, 'notifai', 'credentials.dpapi'), 'utf8')
    expect(onDisk).not.toContain(OTHER.secret)
    assertNoSecretInArgs([...good.calls, ...failing.calls])
  })

  it('returns null when unprotect fails', () => {
    const { env } = sandbox('dpapi-unprotect-fail')
    const saved = mockDpapi()
    new WindowsDpapiStore(env, { run: saved.runner }).save(SAMPLE)
    const failing = mockDpapi({ failUnprotect: true })
    expect(new WindowsDpapiStore(env, { run: failing.runner }).load()).toBeNull()
    assertNoSecretInArgs([...saved.calls, ...failing.calls])
  })

  it('refuses to save when LOCALAPPDATA is missing', () => {
    const store = new WindowsDpapiStore({}, { run: mockDpapi().runner })
    expect(store.load()).toBeNull()
    expect(() => store.save(SAMPLE)).toThrow(/LOCALAPPDATA is missing/)
    expect(store.describe()).toBe('Windows DPAPI current-user (LOCALAPPDATA unset)')
    store.clear()
  })

  it('does not invoke a process for a missing or corrupt file', () => {
    const { env } = sandbox('dpapi-no-process')
    const { runner, calls } = mockDpapi()
    const store = new WindowsDpapiStore(env, { run: runner })
    expect(store.load()).toBeNull()
    const file = path.join(env.LOCALAPPDATA!, 'notifai', 'credentials.dpapi')
    writeRaw(file, 'corrupt')
    expect(store.load()).toBeNull()
    expect(calls).toEqual([])
  })
})
