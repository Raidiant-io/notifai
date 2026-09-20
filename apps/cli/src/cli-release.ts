import { packageVersion } from './release.js'
import { cliDistTagsUrl } from './cli-contract.js'
import { compareVersions, isSemVer } from './version.js'

/**
 * The newest published CLI, read from the registry that publishes it.
 *
 * Which version is newest is a registry fact. Doctor consults it as a
 * best-effort, cached, short-timeout hint in human and structured diagnostics.
 * Automatic lifecycle notices have their own persistent throttle.
 */
const DIST_TAGS_URL = cliDistTagsUrl()
const REQUEST_TIMEOUT_MS = 2_000
const CACHE_TTL_MS = 60 * 60 * 1000

let cached: { value: string | null; at: number } | null = null

export function shouldConsultCliRegistry(input: {
  env?: NodeJS.ProcessEnv
}): boolean {
  const ci = input.env?.['CI']
  return ci !== '1' && ci !== 'true'
}

export async function latestPublishedCliVersion(
  fetchImpl: typeof fetch = fetch,
  options: { useCache?: boolean } = {},
): Promise<string | null> {
  if (options.useCache !== false && cached !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  try {
    const response = await fetchImpl(DIST_TAGS_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return null
    const latest = (body as { latest?: unknown }).latest
    if (typeof latest !== 'string' || !isSemVer(latest)) {
      return null
    }
    if (options.useCache !== false) cached = { value: latest, at: Date.now() }
    return latest
  } catch {
    return null
  }
}

export function newerPublishedCli(local: string | null, latest: string | null): string | null {
  if (local === null || latest === null) return null
  return compareVersions(latest, local) === 'after' ? latest : null
}

export function thisCliVersion(): string | null {
  return packageVersion()
}

export function resetLatestPublishedCliVersionForTest(): void {
  cached = null
}
