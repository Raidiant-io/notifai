import path from 'node:path'
import { HOOK_EVENT_PATTERN } from './hook-events.js'

const OPTIONS = ' -NoLogo -NoProfile -NonInteractive -EncodedCommand '
const PREAMBLE = "$ErrorActionPreference = 'Stop'; "
const SUFFIX = '; exit $LASTEXITCODE'
const SYSTEM_POWERSHELL = /^[a-z]:\\[a-z0-9_.\\-]+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i

export function encodeWindowsCodexCommand(command: string): string {
  const executable = path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // An unquoted absolute system path works in both shells. Never search a
  // project's current directory or PATH for the interpreter. Adapter paths
  // can contain any legal filename characters; they are encoded literals.
  if (!SYSTEM_POWERSHELL.test(executable)) throw new Error('Windows PowerShell system path cannot be represented safely in the selected hook shells')
  return executable + OPTIONS + Buffer.from(PREAMBLE + command + SUFFIX, 'utf16le').toString('base64')
}

/** Only the exact Notifai invocation qualifies; arbitrary encoded scripts stay foreign. */
export function decodeWindowsCodexCommand(command: string): string | null {
  const index = command.indexOf(OPTIONS)
  if (index < 0 || !SYSTEM_POWERSHELL.test(command.slice(0, index))) return null
  const encoded = command.slice(index + OPTIONS.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded || bytes.length % 2 !== 0) return null
  const body = bytes.toString('utf16le')
  if (!body.startsWith(PREAMBLE) || !body.endsWith(SUFFIX)) return null
  const invocation = body.slice(PREAMBLE.length, -SUFFIX.length)
  const literal = "'(?:[^']|'')+'"
  const shape = new RegExp(`^& ${literal}(?: ${literal})? hook (${HOOK_EVENT_PATTERN}) --owner notifai --harness codex(?: --integration-revision [a-f0-9]{64})?$`)
  return shape.test(invocation) ? invocation : null
}

export function windowsCodexCommandsInSource(source: string): string[] {
  // Sources may be plain commands or JSON documents with escaped backslashes.
  return [...source.matchAll(/[A-Za-z]:\\+[A-Za-z0-9_.\\-]+\\+System32\\+WindowsPowerShell\\+v1\.0\\+powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+/g)]
    .map(match => decodeWindowsCodexCommand(match[0].replaceAll('\\\\', '\\')))
    .filter((command): command is string => command !== null)
}
