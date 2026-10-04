import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'

/** Approval proof stays local. Never attach this artifact to a Notification Request. */
export function pairingQrPath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'pairing-qr.png')
}

export function pairingQrTextPath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'pairing-qr.txt')
}

export async function renderPairingQr(env: NodeJS.ProcessEnv, url: string): Promise<string> {
  const file = pairingQrPath(env)
  const { default: QRCode } = await import('qrcode')
  const bytes = await QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', width: 512, margin: 4 })
  atomicWriteFileSync(file, bytes, { mode: 0o600, preserveMode: false, requireCurrentUserOwner: true })
  const text = await terminalPairingQr(url, false)
  atomicWriteFileSync(pairingQrTextPath(env), text, { mode: 0o600, preserveMode: false, requireCurrentUserOwner: true })
  return file
}

export async function terminalPairingQr(url: string, ansi = true): Promise<string> {
  const { default: QRCode } = await import('qrcode')
  return QRCode.toString(url, { type: ansi ? 'terminal' : 'utf8', small: true, errorCorrectionLevel: 'M', margin: 4 })
}
