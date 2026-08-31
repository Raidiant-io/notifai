#!/usr/bin/env node
/**
 * Refuse to publish a CLI or protocol that a deployed production service would
 * reject. The server is deliberately upgraded first: older shipped CLIs omit
 * the contract header and continue working; this gate prevents a newer npm
 * client from getting ahead of that deployed service.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SERVICE_ORIGIN = 'https://api.notifai.sh'
const REQUEST_TIMEOUT_MS = 10_000

export function capabilityUrl(origin) {
  const service = new URL(origin)
  if (service.protocol !== 'https:') {
    throw new Error('the release gate only trusts an HTTPS service origin')
  }
  return new URL('/api/v1/capabilities/ios', service).toString()
}

export async function verifyLiveServerContract({
  expectedFingerprint,
  origin = DEFAULT_SERVICE_ORIGIN,
  fetchImpl = fetch,
}) {
  const url = capabilityUrl(origin)
  let response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`could not read the deployed service contract: ${detail}`)
  }
  if (!response.ok) {
    throw new Error(`could not read the deployed service contract (HTTP ${response.status})`)
  }

  let document
  try {
    document = await response.json()
  } catch {
    throw new Error('the deployed service contract was not valid JSON')
  }
  if (
    document === null ||
    typeof document !== 'object' ||
    typeof document.notification_contract_fingerprint !== 'string'
  ) {
    throw new Error('the deployed service does not advertise a Notification Request contract')
  }
  if (document.notification_contract_fingerprint !== expectedFingerprint) {
    throw new Error(
      'The deployed service does not accept this release’s Notification Request contract. ' +
        'Deploy the matching service first; no package was published.',
    )
  }
}

async function main() {
  const protocol = await import(
    pathToFileURL(path.join(root, 'packages/protocol/dist/index.js')).href,
  )
  await verifyLiveServerContract({
    expectedFingerprint: protocol.NOTIFICATION_CONTRACT_FINGERPRINT,
  })
  console.log('Deployed service accepts this Notification Request contract.')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
