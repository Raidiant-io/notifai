import { HOOK_EVENT_PATTERN } from './hook-events.js'

const PREFIX = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '
const SUFFIX = '; exit $LASTEXITCODE'

export function encodeWindowsCodexCommand(command: string): string {
  return PREFIX + Buffer.from(command + SUFFIX, 'utf16le').toString('base64')
}

/** Only the exact Notifai invocation qualifies; arbitrary encoded scripts stay foreign. */
export function decodeWindowsCodexCommand(command: string): string | null {
  if (!command.startsWith(PREFIX)) return null
  const encoded = command.slice(PREFIX.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded || bytes.length % 2 !== 0) return null
  const body = bytes.toString('utf16le')
  if (!body.endsWith(SUFFIX)) return null
  const invocation = body.slice(0, -SUFFIX.length)
  const literal = "'(?:[^']|'')+'"
  const shape = new RegExp(`^& ${literal}(?: ${literal})? hook (${HOOK_EVENT_PATTERN}) --owner notifai --harness codex(?: --integration-revision [a-f0-9]{64})?$`)
  return shape.test(invocation) ? invocation : null
}

export function windowsCodexCommandsInSource(source: string): string[] {
  return [...source.matchAll(/powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+/g)]
    .map(match => decodeWindowsCodexCommand(match[0])).filter((command): command is string => command !== null)
}
