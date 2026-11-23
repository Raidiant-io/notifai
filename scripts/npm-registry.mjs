import { setTimeout as delay } from 'node:timers/promises'

const REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const PROPAGATION_WINDOW_MS = 10 * 60_000
const FINAL_READ_BUDGET_MS = 5_000

export async function readRegistryVersion(name, version, fetchImpl = fetch, timeoutMs = 10_000) {
  const response = await fetchImpl(`${REGISTRY_ORIGIN}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'Cache-Control': 'no-cache' },
  })
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(`npm registry lookup failed (HTTP ${response.status})`)
  }
  return response
}

export async function downloadPublishedTarball(name, version, {
  fetchImpl = fetch, wait = delay, now = () => performance.now(), warn = console.warn,
} = {}) {
  const label = `${name}@${version}`
  const deadline = now() + PROPAGATION_WINDOW_MS
  const requestTimeout = maximum => Math.min(maximum, Math.max(1, Math.ceil(deadline - now())))
  let tarballUrl
  let delayMs = 1000

  // A successful publish can precede both version metadata and the tarball.
  // Share one read-only deadline across those two phases.
  for (;;) {
    if (!tarballUrl) {
      const metadata = await readRegistryVersion(name, version, fetchImpl, requestTimeout(10_000))
      if (metadata.status === 200) {
        const { dist } = await metadata.json()
        if (typeof dist?.tarball !== 'string' || !dist.tarball) throw new Error('Registry version has no tarball URL')
        tarballUrl = new URL(dist.tarball)
        if (tarballUrl.origin !== REGISTRY_ORIGIN || tarballUrl.username || tarballUrl.password) {
          throw new Error('Registry tarball must use the canonical npm origin')
        }
      } else {
        await metadata.body?.cancel()
      }
    }

    if (tarballUrl) {
      const response = await fetchImpl(tarballUrl, {
        redirect: 'error', signal: AbortSignal.timeout(requestTimeout(120_000)), headers: { 'Cache-Control': 'no-cache' },
      })
      if (response.status === 200) return Buffer.from(await response.arrayBuffer())
      if (response.status !== 404) throw new Error(`npm registry tarball download failed (HTTP ${response.status})`)
      await response.body?.cancel()
    }

    const missing = tarballUrl ? 'tarball' : 'version metadata'
    // Shorten the last backoff so it leaves time for one final registry read.
    const waitMs = Math.min(delayMs, Math.floor(deadline - now()) - FINAL_READ_BUDGET_MS)
    if (waitMs <= 0) {
      throw new Error(`npm registry ${missing} remained unavailable (HTTP 404) within the 10-minute propagation window`)
    }
    warn(`${label}: npm registry ${missing} returned HTTP 404; reading again in ${waitMs / 1000}s`)
    await wait(waitMs)
    delayMs = Math.min(delayMs * 2, 30_000)
  }
}
