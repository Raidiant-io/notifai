import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { COMPUTER_PLATFORMS, type ComputerPlatform } from '@raidiant/notifai-protocol'
import { stateDir } from './config.js'
import { defaultProcessRunner, type ProcessRunner } from './credentials.js'

/**
 * Which computer this CLI runs on, so the service lists one computer once
 * however often it signed in (from another OS user, after a reinstall, or by
 * signing in again). The value is a SHA-256 of the operating system's own
 * computer identifier; the identifier itself never leaves this computer, and
 * the service hashes the value again with the Account before storing it.
 *
 * Reading the identifier can start a helper process, so the result is kept in
 * this OS user's state directory and read from there afterwards. Any failure
 * leaves the computer unnamed; the service then falls back to the name.
 */
const KEY_FILE = 'computer-key'
const HELPER_TIMEOUT_MS = 2_000

export interface ComputerIdentityOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  run?: ProcessRunner
  readFile?: (file: string) => string
}

export function computerPlatform(platform: NodeJS.Platform = process.platform): ComputerPlatform | null {
  return (COMPUTER_PLATFORMS as readonly string[]).includes(platform) ? platform as ComputerPlatform : null
}

/** The operating system's identifier for this computer, or null when it can't be read. */
export function rawComputerId(options: ComputerIdentityOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  const run = options.run ?? defaultProcessRunner
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'))
  const output = (command: string, args: string[]) => {
    const result = run.run({ command, args, input: Buffer.alloc(0), timeoutMs: HELPER_TIMEOUT_MS })
    return result.status === 0 ? result.stdout.toString('utf8') : ''
  }
  let id: string | undefined
  if (platform === 'darwin') {
    id = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']))?.[1]
  } else if (platform === 'win32') {
    id = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(output('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']))?.[1]
  } else if (platform === 'linux') {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        id = readFile(file).trim()
      } catch {
        id = undefined
      }
      if (id) break
    }
  }
  const trimmed = id?.trim().toLowerCase()
  return trimmed ? trimmed : null
}

/** What the CLI sends for a raw identifier. */
export function computerKeyOf(rawId: string): string {
  return createHash('sha256').update(`notifai-computer-v1\0${rawId}`).digest('hex')
}

/** This computer's key, from the state directory or read once and kept there; null when unknown. */
export function computerKey(options: ComputerIdentityOptions = {}): string | null {
  const file = path.join(stateDir(options.env ?? process.env, options.platform ?? process.platform), KEY_FILE)
  try {
    const kept = readFileSync(file, 'utf8').trim()
    if (/^[a-f0-9]{64}$/.test(kept)) return kept
  } catch {
    // Not kept yet.
  }
  const raw = rawComputerId(options)
  if (!raw) return null
  const key = computerKeyOf(raw)
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${key}\n`, { mode: 0o600 })
  } catch {
    // Read again next time.
  }
  return key
}
