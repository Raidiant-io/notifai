import { packageVersion } from './release.js'

/**
 * The newest published CLI, read from the registry that publishes it.
 *
 * Which version is newest is a registry fact. Doctor consults it as a
 * best-effort, cached, short-timeout hint: never fatal, and never on a
 * non-interactive or CI invocation — those callers already get structured
 * support state from the server when they are signed in.
 */
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@raidiant/notifai/dist-tags'
const REQUEST_TIMEOUT_MS = 2_000
const CACHE_TTL_MS = 60 * 60 * 1000

let cached: { value: string | null; at: number } | null = null

export function compareCliSemVer(left: string, right: string): number | null {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value)
    if (!match) return null
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const a = parse(left)
  const b = parse(right)
  if (a === null || b === null) return null
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return 0
}

export function shouldConsultCliRegistry(input: {
  interactive?: boolean
  json?: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  if (input.json === true) return false
  if (input.interactive !== true) return false
  const ci = input.env?.['CI']
  return ci !== '1' && ci !== 'true'
}

export async function latestPublishedCliVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (cached !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  try {
    const response = await fetchImpl(DIST_TAGS_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return cached?.value ?? null
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return cached?.value ?? null
    const latest = (body as { latest?: unknown }).latest
    if (typeof latest !== 'string' || compareCliSemVer(latest, '0.0.0') === null) {
      return cached?.value ?? null
    }
    cached = { value: latest, at: Date.now() }
    return latest
  } catch {
    return cached?.value ?? null
  }
}

export function newerPublishedCli(local: string | null, latest: string | null): string | null {
  if (local === null || latest === null) return null
  const comparison = compareCliSemVer(latest, local)
  return comparison !== null && comparison > 0 ? latest : null
}

export function thisCliVersion(): string | null {
  return packageVersion()
}

export function resetLatestPublishedCliVersionForTest(): void {
  cached = null
}
