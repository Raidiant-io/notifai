import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { globalConfigDir } from './config.js'

export interface MachineCredential {
  machineId: string
  secret: string
  baseUrl: string
  machineName: string
}

/** Non-secret ownership metadata for a frozen authenticated operation. */
export interface ServiceIdentity { base_url: string; machine_id: string }

export interface CredentialStore {
  load(): MachineCredential | null
  save(credential: MachineCredential): void
  clear(): void
  /** Where the secret lives, for `doctor` and docs. */
  describe(): string
}

export interface RunCommandSpec {
  command: string
  args: readonly string[]
  input: Buffer
  timeoutMs?: number
}

export interface RunCommandResult {
  status: number
  stdout: Buffer
}

/** Injected process seam. Production uses `defaultProcessRunner`. */
export interface ProcessRunner {
  run(spec: RunCommandSpec): RunCommandResult
}

export interface CredentialStoreOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  run?: ProcessRunner
  keychainAvailable?: boolean
  secretServiceAvailable?: boolean
  /**
   * Ceiling for one OS store helper run (Keychain `security`, DPAPI
   * PowerShell, `secret-tool`). A hook passes its own share of the harness
   * timeout so no helper can outlive the hook that started it.
   */
  helperTimeoutMs?: number
}

/** The helper ceiling a store uses: its own default, never above the caller's. */
function helperTimeout(defaultMs: number, options: CredentialStoreOptions): number {
  const requested = options.helperTimeoutMs
  return requested === undefined || !Number.isFinite(requested) || requested <= 0
    ? defaultMs
    : Math.min(defaultMs, Math.floor(requested))
}

const SERVICE = 'io.notifai.cli'
const CREDENTIAL_FORMAT = 'notifai.machine-credential.v1'
const LINUX_AUTHORITY_FORMAT = 'notifai.linux-credential-authority.v1'
type LinuxCredentialAuthority = 'secret-service' | 'cleared'
type CredentialFileState =
  | { kind: 'missing' }
  | { kind: 'credential'; credential: MachineCredential }
  | { kind: 'authority'; authority: LinuxCredentialAuthority }
  | { kind: 'unrecognized' }
const DPAPI_FORMAT = 'notifai.dpapi.current-user.v1'
const DPAPI_ENTROPY = 'io.notifai.cli'
// Inbox Windows PowerShell can have a slow first start on a newly provisioned
// or heavily loaded machine. Keep the helper bounded without rejecting a
// valid DPAPI operation during that cold-start window. This is the explicit
// CLI's ceiling; a hook passes its own smaller `helperTimeoutMs`.
export const DPAPI_TIMEOUT_MS = 30_000
const DPAPI_FILE = 'credentials.dpapi'
export const KEYCHAIN_TIMEOUT_MS = 15_000

// Use .NET directly: loading PowerShell's Utility module for Add-Type or
// New-Object can exceed the helper timeout under Git Bash on Windows ARM.
// The inbox Windows PowerShell host uses .NET Framework's System.Security.
const PROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Security')",
  '$in = [System.IO.MemoryStream]::new()',
  '[Console]::OpenStandardInput().CopyTo($in)',
  `$entropy = [System.Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
  '$protected = [System.Security.Cryptography.ProtectedData]::Protect($in.ToArray(), $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '$bytes = [System.Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($protected))',
  '[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)',
].join('; ')

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Security')",
  '$b64 = [System.Text.Encoding]::ASCII.GetString((& { $in = [System.IO.MemoryStream]::new(); [Console]::OpenStandardInput().CopyTo($in); $in.ToArray() })).Trim()',
  '$protected = [Convert]::FromBase64String($b64)',
  `$entropy = [System.Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
  '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::OpenStandardOutput().Write($plain, 0, $plain.Length)',
].join('; ')

const PROTECT_ENCODED = encodePowerShell(PROTECT_SCRIPT)
const UNPROTECT_ENCODED = encodePowerShell(UNPROTECT_SCRIPT)

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function powerShellInvocation(encoded: string, env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const root = env['SystemRoot'] || env['SYSTEMROOT'] || 'C:\\Windows'
  return {
    command: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
  }
}

/** Which DPAPI operation a process invocation asked for. Args never carry secrets. */
export function windowsDpapiOperation(args: readonly string[]): 'protect' | 'unprotect' | null {
  const index = args.indexOf('-EncodedCommand')
  const encoded = index >= 0 ? args[index + 1] : undefined
  if (encoded === PROTECT_ENCODED) return 'protect'
  if (encoded === UNPROTECT_ENCODED) return 'unprotect'
  return null
}

export const defaultProcessRunner: ProcessRunner = {
  run(spec) {
    const result = spawnSync(spec.command, [...spec.args], {
      input: spec.input,
      timeout: spec.timeoutMs ?? DPAPI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0)
    if (result.error) return { status: 1, stdout: Buffer.alloc(0) }
    return { status: result.status ?? 1, stdout }
  },
}

/**
 * macOS Keychain via the first-party `security` Security.framework client.
 *
 * `security add-generic-password -w <value>` puts the value in process argv.
 * Interactive mode instead parses a command from stdin, so the credential
 * crosses the helper boundary only through the pipe. `-X` keeps arbitrary
 * serialized bytes out of the command parser's quoting rules.
 */
export class KeychainStore implements CredentialStore {
  private readonly run: ProcessRunner
  private readonly timeoutMs: number

  constructor(options: CredentialStoreOptions = {}) {
    this.run = options.run ?? defaultProcessRunner
    this.timeoutMs = helperTimeout(KEYCHAIN_TIMEOUT_MS, options)
  }

  load(): MachineCredential | null {
    const result = this.run.run({
      command: 'security',
      args: ['find-generic-password', '-s', SERVICE, '-a', 'machine', '-w'],
      input: Buffer.alloc(0),
      timeoutMs: this.timeoutMs,
    })
    if (result.status !== 0) return null
    return parseCredentialJson(keychainPassword(result.stdout.toString('utf8').trim()))
  }

  save(credential: MachineCredential): void {
    const serialized = Buffer.from(JSON.stringify(serializeCredential(credential)), 'utf8')
    const command = Buffer.from(
      `add-generic-password -U -s ${SERVICE} -a machine -X ${serialized.toString('hex')}\n`,
      'ascii',
    )
    const result = this.run.run({
      command: 'security',
      args: ['-q', '-i'],
      input: command,
      timeoutMs: this.timeoutMs,
    })
    if (result.status !== 0) {
      throw new Error('macOS Keychain credential save failed')
    }
  }

  clear(): void {
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', 'machine'], {
        stdio: 'ignore',
        timeout: this.timeoutMs,
      })
    } catch {
      // nothing stored
    }
  }

  describe(): string {
    return `macOS Keychain (${SERVICE})`
  }
}

/**
 * Explicit plaintext file store.
 *
 * Default on Linux without a Secret Service, where mode 0600 is a real ACL.
 * Also the `NOTIFAI_CREDENTIALS=file` development and test escape hatch on
 * every platform. POSIX mode bits are not an NTFS ACL, so this is not a protected
 * Windows store.
 */
export class FileStore implements CredentialStore {
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform

  constructor(env: NodeJS.ProcessEnv = process.env, options: CredentialStoreOptions = {}) {
    this.env = env
    this.platform = options.platform ?? process.platform
  }

  private filePath(): string {
    return path.join(globalConfigDir(this.env, this.platform), 'credentials.json')
  }

  load(): MachineCredential | null {
    const state = this.readState()
    if (state.kind === 'authority' && state.authority === 'secret-service' &&
        this.env['NOTIFAI_CREDENTIALS'] !== 'file') {
      throw new Error('Secret Service credential unavailable; restore access to its session bus and keyring, then retry')
    }
    return state.kind === 'credential' ? state.credential : null
  }

  /** The same local file carries either a credential or non-secret Linux authority. */
  readState(): CredentialFileState {
    const file = this.filePath()
    if (!existsSync(file)) return { kind: 'missing' }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (this.platform === 'linux' && raw !== null && typeof raw === 'object') {
        const value = raw as Record<string, unknown>
        if (value['format'] === LINUX_AUTHORITY_FORMAT) {
          const authority = value['authority']
          if ((authority === 'secret-service' || authority === 'cleared') &&
              Object.keys(value).every((key) => key === 'format' || key === 'authority')) {
            return { kind: 'authority', authority }
          }
          return { kind: 'unrecognized' }
        }
        if ('authority' in value) return { kind: 'unrecognized' }
      }
      const credential = parseCredential(raw)
      return credential ? { kind: 'credential', credential } : { kind: 'unrecognized' }
    } catch {
      return { kind: 'unrecognized' }
    }
  }

  save(credential: MachineCredential): void {
    const expectedContentsSha256 = this.contentsHash()
    if (this.platform === 'linux') {
      const state = this.readState()
      if (state.kind === 'unrecognized') throw new Error('Unrecognized credential file; left untouched')
      if (state.kind === 'authority' && state.authority === 'secret-service' &&
          this.env['NOTIFAI_CREDENTIALS'] !== 'file') {
        throw new Error('Secret Service owns this credential; restore access or, only if the User asks and this is not a shared machine, set NOTIFAI_CREDENTIALS=file to store the credential in plaintext')
      }
    }
    this.write(serializeCredential(credential), expectedContentsSha256)
  }

  /** Bind authority publication to the local file seen before a helper call. */
  contentsHash(): string | null {
    const file = this.filePath()
    return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
  }

  recordLinuxAuthority(authority: LinuxCredentialAuthority, expectedContentsSha256 = this.contentsHash()): void {
    if (this.platform !== 'linux') throw new Error('Linux credential authority requires Linux')
    const state = this.readState()
    if (state.kind === 'unrecognized') throw new Error('Unrecognized credential file; left untouched')
    if (authority === 'secret-service' && state.kind === 'credential') {
      throw new Error('File credential remains authoritative; refusing implicit Secret Service migration')
    }
    this.write({ format: LINUX_AUTHORITY_FORMAT, authority }, expectedContentsSha256)
  }

  private write(value: Record<string, string>, expectedContentsSha256: string | null): void {
    atomicWriteFileSync(this.filePath(), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      preserveMode: false,
      requireCurrentUserOwner: true,
      expectedContentsSha256,
    })
  }

  clear(): void {
    if (this.platform === 'linux') {
      // Absence would permit an older, inaccessible service item to reappear.
      this.recordLinuxAuthority('cleared')
      return
    }
    rmSync(this.filePath(), { force: true })
  }

  describe(): string {
    const file = this.filePath()
    if (this.platform === 'win32') {
      return `plaintext file ${file} (NOTIFAI_CREDENTIALS=file; POSIX mode bits are not protection on NTFS)`
    }
    return `plaintext file ${file} (mode 0600)`
  }
}

/**
 * Windows default: DPAPI CurrentUser via first-party PowerShell.
 *
 * The protected blob lives under LOCALAPPDATA, never roaming APPDATA.
 * Plaintext crosses the process boundary only on stdin/stdout — never as a
 * command-line argument.
 */
export class WindowsDpapiStore implements CredentialStore {
  private readonly env: NodeJS.ProcessEnv
  private readonly run: ProcessRunner
  private readonly timeoutMs: number

  constructor(env: NodeJS.ProcessEnv = process.env, options: CredentialStoreOptions = {}) {
    this.env = env
    this.run = options.run ?? defaultProcessRunner
    this.timeoutMs = helperTimeout(DPAPI_TIMEOUT_MS, options)
  }

  private filePath(): string | null {
    const local = this.env['LOCALAPPDATA']
    if (typeof local !== 'string' || local.trim() === '') return null
    return path.join(local, 'notifai', DPAPI_FILE)
  }

  load(): MachineCredential | null {
    const file = this.filePath()
    if (file === null || !existsSync(file)) return null
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return null
    }
    const blob = parseDpapiEnvelope(text)
    if (blob === null) return null
    const plain = this.unprotect(blob)
    return plain === null ? null : parseCredentialJson(plain)
  }

  save(credential: MachineCredential): void {
    const file = this.filePath()
    if (file === null) {
      throw new Error('Windows credential store path is not configured (LOCALAPPDATA is missing)')
    }
    const blob = this.protect(Buffer.from(JSON.stringify(serializeCredential(credential)), 'utf8'))
    atomicWriteFileSync(file, `${JSON.stringify({ format: DPAPI_FORMAT, data: blob })}\n`, {
      mode: 0o600,
      preserveMode: false,
      requireCurrentUserOwner: true,
    })
  }

  clear(): void {
    const file = this.filePath()
    if (file === null) return
    rmSync(file, { force: true })
  }

  describe(): string {
    const file = this.filePath()
    if (file === null) return 'Windows DPAPI current-user (LOCALAPPDATA unset)'
    return `Windows DPAPI current-user (${file})`
  }

  private protect(plaintext: Buffer): string {
    const result = this.invoke('protect', plaintext)
    if (result.status !== 0) {
      throw new Error('Windows credential protection failed')
    }
    const encoded = result.stdout.toString('utf8').trim()
    if (!isBase64(encoded)) {
      throw new Error('Windows credential protection failed')
    }
    return encoded
  }

  private unprotect(blob: string): string | null {
    const result = this.invoke('unprotect', Buffer.from(blob, 'utf8'))
    if (result.status !== 0) return null
    const plain = result.stdout.toString('utf8')
    return plain === '' ? null : plain
  }

  private invoke(operation: 'protect' | 'unprotect', input: Buffer): RunCommandResult {
    const encoded = operation === 'protect' ? PROTECT_ENCODED : UNPROTECT_ENCODED
    const invocation = powerShellInvocation(encoded, this.env)
    return this.run.run({
      command: invocation.command,
      args: invocation.args,
      input,
      timeoutMs: this.timeoutMs,
    })
  }
}

export const SECRET_TOOL_TIMEOUT_MS = 15_000
const SECRET_ATTRIBUTES = ['service', SERVICE, 'account', 'machine'] as const

/**
 * Linux default when a desktop session offers the Secret Service (GNOME
 * Keyring, KWallet, KeePassXC): libsecret's `secret-tool`, which reads the
 * secret from stdin rather than argv. The desktop Companion App keeps its own
 * session in the same service.
 *
 * An existing file credential stays authoritative across desktop and headless
 * invocations. New service credentials record only non-secret authority in
 * that file; temporary loss of service access never selects a different store.
 */
export class SecretServiceStore implements CredentialStore {
  private readonly run: ProcessRunner
  private readonly file: FileStore
  private readonly available: boolean
  private readonly timeoutMs: number

  constructor(env: NodeJS.ProcessEnv = process.env, options: CredentialStoreOptions = {}) {
    this.run = options.run ?? defaultProcessRunner
    this.file = new FileStore(env, { platform: options.platform ?? 'linux' })
    this.available = options.secretServiceAvailable ?? true
    this.timeoutMs = helperTimeout(SECRET_TOOL_TIMEOUT_MS, options)
  }

  load(): MachineCredential | null {
    const expectedContentsSha256 = this.file.contentsHash()
    const state = this.file.readState()
    if (state.kind === 'credential') return state.credential
    if (state.kind === 'unrecognized' || (state.kind === 'authority' && state.authority === 'cleared')) return null
    this.requireAvailable()
    const result = this.secretTool(['lookup', ...SECRET_ATTRIBUTES], Buffer.alloc(0))
    if (result.status === 0) {
      const stored = parseCredentialJson(result.stdout.toString('utf8').trim())
      if (stored) {
        const changed = new Error('Credential authority changed during Secret Service lookup; retry')
        if (state.kind === 'missing') {
          try {
            this.file.recordLinuxAuthority('secret-service', expectedContentsSha256)
          } catch (err) {
            // A concurrent load recorded the same authority first. Anything
            // else (a sign-out, a file credential) still refuses this lookup.
            const now = this.file.readState()
            if (now.kind === 'authority' && now.authority === 'secret-service') return stored
            throw this.file.contentsHash() === expectedContentsSha256 ? err : changed
          }
        } else if (this.file.contentsHash() !== expectedContentsSha256) {
          throw changed
        }
        return stored
      }
    }
    if (state.kind === 'authority') {
      throw new Error('Secret Service credential unavailable; restore the session bus and unlock the keyring, then retry')
    }
    return null
  }

  save(credential: MachineCredential): void {
    const expectedContentsSha256 = this.file.contentsHash()
    const state = this.file.readState()
    if (state.kind === 'credential') {
      this.file.save(credential)
      return
    }
    if (state.kind === 'unrecognized') throw new Error('Unrecognized credential file; left untouched')
    this.requireAvailable()
    const serialized = Buffer.from(JSON.stringify(serializeCredential(credential)), 'utf8')
    const result = this.secretTool(['store', '--label=Notifai machine credential', ...SECRET_ATTRIBUTES], serialized)
    if (result.status !== 0) {
      throw new Error(
        'Secret Service credential save failed; unlock the keyring and retry, or, only if the User asks and this is not a shared machine, set NOTIFAI_CREDENTIALS=file to store the credential in plaintext',
      )
    }
    this.file.recordLinuxAuthority('secret-service', expectedContentsSha256)
  }

  clear(): void {
    // Fence stale service data first, including when the helper refuses clear.
    this.file.clear()
    this.requireAvailable()
    const result = this.secretTool(['clear', ...SECRET_ATTRIBUTES], Buffer.alloc(0))
    if (result.status !== 0) {
      // libsecret also reports false when no unlocked matches were removed.
      // Search without unlocking so absent items are idempotent, while locked
      // matches and service errors still require a later removal attempt.
      const remaining = this.secretTool(['search', '--all', ...SECRET_ATTRIBUTES], Buffer.alloc(0))
      if (remaining.status === 0 && remaining.stdout.toString('utf8').trim() === '') return
      throw new Error('Secret Service credential clear failed; local access is cleared, but unlock the keyring and retry removal')
    }
  }

  describe(): string {
    const state = this.file.readState()
    if (state.kind === 'credential') return this.file.describe()
    return `Secret Service (${SERVICE})`
  }

  private requireAvailable(): void {
    if (!this.available) {
      throw new Error('Secret Service credential unavailable; restore the session bus and secret-tool, then unlock the keyring and retry')
    }
  }

  private secretTool(args: readonly string[], input: Buffer): RunCommandResult {
    return this.run.run({ command: 'secret-tool', args, input, timeoutMs: this.timeoutMs })
  }
}

/**
 * A session bus and `secret-tool` on PATH. Headless machines (servers, CI,
 * SSH-only boxes) have neither and use a 0600 file for new credentials.
 * Existing Secret Service authority remains selected while its bus is absent.
 */
export function secretServiceAvailable(env: NodeJS.ProcessEnv): boolean {
  const bus = env['DBUS_SESSION_BUS_ADDRESS']
  const runtime = env['XDG_RUNTIME_DIR']
  const hasBus =
    (typeof bus === 'string' && bus !== '') ||
    (typeof runtime === 'string' && runtime !== '' && existsSync(path.join(runtime, 'bus')))
  if (!hasBus) return false
  const searchPath = env['PATH'] ?? ''
  return searchPath
    .split(path.delimiter)
    .some((dir) => dir !== '' && existsSync(path.join(dir, 'secret-tool')))
}

function serializeCredential(credential: MachineCredential): Record<string, string> {
  return { format: CREDENTIAL_FORMAT, ...credential }
}

/**
 * `security -w` prints a password that is not plain ASCII as hex instead of
 * text. A credential is JSON, so it never starts with a hex digit; a
 * non-ASCII machine name such as "Example’s MacBook" comes back hex-encoded.
 */
function keychainPassword(printed: string): string {
  return /^(?:[0-9a-f]{2})+$/i.test(printed) ? Buffer.from(printed, 'hex').toString('utf8') : printed
}

function parseCredentialJson(raw: string): MachineCredential | null {
  try {
    return parseCredential(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

function parseCredential(raw: unknown): MachineCredential | null {
  if (raw === null || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const format = value['format']
  // Unversioned credentials are the pre-epoch v1 representation. A future
  // format is left untouched on disk/keychain and treated as unavailable;
  // interpreting it as v1 could silently change authentication meaning.
  if (format !== undefined && format !== CREDENTIAL_FORMAT) return null
  const machineId = value['machineId']
  const secret = value['secret']
  const baseUrl = value['baseUrl']
  const machineName = value['machineName']
  if (
    typeof machineId !== 'string' ||
    machineId === '' ||
    typeof secret !== 'string' ||
    secret === '' ||
    typeof baseUrl !== 'string' ||
    baseUrl === '' ||
    typeof machineName !== 'string' ||
    machineName === ''
  ) {
    return null
  }
  return { machineId, secret, baseUrl, machineName }
}

function parseDpapiEnvelope(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const value = parsed as Record<string, unknown>
  if (value['format'] !== DPAPI_FORMAT) return null
  const data = value['data']
  if (typeof data !== 'string' || !isBase64(data)) return null
  return data
}

function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

/** Whether the first-party Keychain client runs here, within the caller's helper ceiling. */
function keychainProbeSucceeds(options: CredentialStoreOptions): boolean {
  const result = (options.run ?? defaultProcessRunner).run({
    command: 'security',
    args: ['help'],
    input: Buffer.alloc(0),
    timeoutMs: helperTimeout(KEYCHAIN_TIMEOUT_MS, options),
  })
  return result.status === 0
}

/**
 * A store chosen on its first use.
 *
 * Choosing the macOS store runs a `security` probe. Most invocations, and
 * most hook runs, never read the credential, so they no longer pay for one.
 */
class LazyCredentialStore implements CredentialStore {
  private chosen: CredentialStore | null = null

  constructor(private readonly choose: () => CredentialStore) {}

  private store(): CredentialStore {
    this.chosen ??= this.choose()
    return this.chosen
  }

  load(): MachineCredential | null {
    return this.store().load()
  }

  save(credential: MachineCredential): void {
    this.store().save(credential)
  }

  clear(): void {
    this.store().clear()
  }

  describe(): string {
    return this.store().describe()
  }
}

export function defaultCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
  options: CredentialStoreOptions = {},
): CredentialStore {
  const platform = options.platform ?? process.platform
  if (env['NOTIFAI_CREDENTIALS'] === 'file') return new FileStore(env, { platform })
  if (platform === 'win32') return new WindowsDpapiStore(env, options)
  if (platform === 'linux') {
    const secretService = options.secretServiceAvailable ?? secretServiceAvailable(env)
    const file = new FileStore(env, { platform })
    const state = file.readState()
    if (state.kind === 'credential' || state.kind === 'unrecognized') return file
    const serviceAuthority = state.kind === 'authority' && state.authority === 'secret-service'
    return secretService || serviceAuthority
      ? new SecretServiceStore(env, { ...options, secretServiceAvailable: secretService })
      : file
  }
  if (options.keychainAvailable !== undefined) {
    return options.keychainAvailable ? new KeychainStore(options) : new FileStore(env, { platform })
  }
  if (platform !== 'darwin') return new FileStore(env, { platform })
  return new LazyCredentialStore(() =>
    keychainProbeSucceeds(options) ? new KeychainStore(options) : new FileStore(env, { platform }))
}
