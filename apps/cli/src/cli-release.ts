import { packageVersion } from './release.js'
import { cliDistTagsUrl, cliUpdateChannel, type CliUpdateChannel } from './cli-contract.js'
import { compareReleasePrecedence, isPrerelease, isSemVer } from './version.js'

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

/** The npm dist-tags a CLI installation can update to. */
export interface CliDistTags {
  latest: string
  beta: string | null
}

export interface CliReleaseTarget {
  version: string
  dist_tag: 'latest' | 'beta'
}

let cached: { value: CliDistTags | null; at: number } | null = null

export function shouldConsultCliRegistry(input: {
  env?: NodeJS.ProcessEnv
}): boolean {
  const ci = input.env?.['CI']
  return ci !== '1' && ci !== 'true'
}

/**
 * Accept a registry dist-tags document only when every tag an update can
 * follow is well formed: `latest` is a stable release and `beta`, when
 * present, is a prerelease. Anything else is unreadable, never a guess.
 */
export function parseCliDistTags(body: unknown): CliDistTags | null {
  if (typeof body !== 'object' || body === null) return null
  const { latest, beta } = body as { latest?: unknown; beta?: unknown }
  if (typeof latest !== 'string' || !isSemVer(latest) || isPrerelease(latest)) return null
  if (beta === undefined) return { latest, beta: null }
  if (typeof beta !== 'string' || !isPrerelease(beta)) return null
  return { latest, beta }
}

export async function publishedCliDistTags(
  fetchImpl: typeof fetch = fetch,
  options: { useCache?: boolean } = {},
): Promise<CliDistTags | null> {
  if (options.useCache !== false && cached !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  try {
    const response = await fetchImpl(DIST_TAGS_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const tags = parseCliDistTags(await response.json())
    if (tags === null) return null
    if (options.useCache !== false) cached = { value: tags, at: Date.now() }
    return tags
  } catch {
    return null
  }
}

/**
 * The release a channel updates to. Stable follows `latest`. Beta follows
 * whichever of `beta` and `latest` has the higher SemVer precedence, so a
 * tester moves on to the stable release once it ships.
 */
export function cliReleaseTarget(tags: CliDistTags, channel: CliUpdateChannel): CliReleaseTarget {
  if (channel === 'beta' && tags.beta !== null && compareReleasePrecedence(tags.beta, tags.latest) === 'after') {
    return { version: tags.beta, dist_tag: 'beta' }
  }
  return { version: tags.latest, dist_tag: 'latest' }
}

/**
 * The published release newer than `local` on the channel `local` belongs to,
 * or null. A prerelease installation is offered both newer betas and the
 * stable release that supersedes it.
 */
export function newerPublishedCli(local: string | null, tags: CliDistTags | null): string | null {
  if (local === null || tags === null) return null
  const target = cliReleaseTarget(tags, cliUpdateChannel(local))
  return compareReleasePrecedence(target.version, local) === 'after' ? target.version : null
}

export function thisCliVersion(): string | null {
  return packageVersion()
}

export function resetPublishedCliDistTagsForTest(): void {
  cached = null
}
