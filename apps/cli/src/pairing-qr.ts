import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'

/** Approval proof stays local. Never attach this artifact to a Notification Request. */
export function pairingQrPath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'pairing-qr.png')
}

export async function renderPairingQr(env: NodeJS.ProcessEnv, url: string): Promise<string> {
  const file = pairingQrPath(env)
  const { default: QRCode } = await import('qrcode')
  const bytes = await QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', width: 512, margin: 4 })
  atomicWriteFileSync(file, bytes, { mode: 0o600, preserveMode: false, requireCurrentUserOwner: true })
  return file
}

export async function terminalPairingQr(url: string): Promise<string> {
  const { default: QRCode } = await import('qrcode')
  return QRCode.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'M', margin: 4 })
}
