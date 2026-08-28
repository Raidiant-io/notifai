import { execFileSync, spawnSync } from 'node:child_process'
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
}

const SERVICE = 'io.notifai.cli'
const CREDENTIAL_FORMAT = 'notifai.machine-credential.v1'
const DPAPI_FORMAT = 'notifai.dpapi.current-user.v1'
const DPAPI_ENTROPY = 'io.notifai.cli'
// Inbox Windows PowerShell can have a slow first start on a newly provisioned
// or heavily loaded machine. Keep the helper bounded without rejecting a
// valid DPAPI operation during that cold-start window.
const DPAPI_TIMEOUT_MS = 30_000
const DPAPI_FILE = 'credentials.dpapi'
const KEYCHAIN_TIMEOUT_MS = 15_000

const PROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$in = New-Object System.IO.MemoryStream',
  '[Console]::OpenStandardInput().CopyTo($in)',
  `$entropy = [System.Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
  '$protected = [System.Security.Cryptography.ProtectedData]::Protect($in.ToArray(), $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '$bytes = [System.Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($protected))',
  '[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)',
].join('; ')

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$b64 = [System.Text.Encoding]::ASCII.GetString((& { $in = New-Object System.IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($in); $in.ToArray() })).Trim()',
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

  constructor(options: CredentialStoreOptions = {}) {
    this.run = options.run ?? defaultProcessRunner
  }

  load(): MachineCredential | null {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', SERVICE, '-a', 'machine', '-w'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .toString()
        .trim()
      return parseCredentialJson(raw)
    } catch {
      return null
    }
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
      timeoutMs: KEYCHAIN_TIMEOUT_MS,
    })
    if (result.status !== 0) {
      throw new Error('macOS Keychain credential save failed')
    }
  }

  clear(): void {
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', 'machine'], {
        stdio: 'ignore',
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
 * Default on Linux, where mode 0600 is a real ACL. Also the
 * `NOTIFAI_CREDENTIALS=file` development and test escape hatch on every
 * platform. POSIX mode bits are not an NTFS ACL, so this is not a protected
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
    const file = this.filePath()
    if (!existsSync(file)) return null
    try {
      return parseCredentialJson(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  save(credential: MachineCredential): void {
    atomicWriteFileSync(this.filePath(), `${JSON.stringify(serializeCredential(credential), null, 2)}\n`, {
      mode: 0o600,
      preserveMode: false,
      requireCurrentUserOwner: true,
    })
  }

  clear(): void {
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

  constructor(env: NodeJS.ProcessEnv = process.env, options: CredentialStoreOptions = {}) {
    this.env = env
    this.run = options.run ?? defaultProcessRunner
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
      timeoutMs: DPAPI_TIMEOUT_MS,
    })
  }
}

function serializeCredential(credential: MachineCredential): Record<string, string> {
  return { format: CREDENTIAL_FORMAT, ...credential }
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

function keychainProbeSucceeds(): boolean {
  try {
    execFileSync('security', ['help'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function defaultCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
  options: CredentialStoreOptions = {},
): CredentialStore {
  const platform = options.platform ?? process.platform
  if (env['NOTIFAI_CREDENTIALS'] === 'file') return new FileStore(env, { platform })
  if (platform === 'win32') return new WindowsDpapiStore(env, options)
  const keychain =
    options.keychainAvailable !== undefined
      ? options.keychainAvailable
      : platform === 'darwin' && keychainProbeSucceeds()
  if (keychain) return new KeychainStore(options)
  return new FileStore(env, { platform })
}
