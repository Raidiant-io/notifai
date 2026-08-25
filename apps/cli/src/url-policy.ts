import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'

/**
 * The URL trust policy: which network destinations this CLI will touch on
 * input it did not author. `docs/TRUST.md` is the written policy; this module
 * is its enforcement, and the two must change together.
 *
 * The threat is not a hostile user — it is hostile *input* reaching a
 * trusted user's CLI: a cloned repository, a compromised server response, or
 * an agent following text it found in a working tree. Every rule here is
 * therefore fail-closed, and every escape hatch resolves only from
 * configuration layers the User owns — never from a repository.
 */

/** The one dashboard origin the shipped service uses for pairing approval. */
export const CANONICAL_DASHBOARD_ORIGIN = 'https://app.notifai.sh'

/** Redirect hops a remote image fetch may follow, each re-validated. */
export const MEDIA_REDIRECT_LIMIT = 3

/** One address attempt must not hold an agent command indefinitely. */
export const MEDIA_FETCH_TIMEOUT_MS = 15_000

export type UrlRefusal = { ok: false; reason: string }

/**
 * Normalize one configured origin entry to `scheme://host[:port]`, or null
 * when the entry is not a bare http(s) origin. Paths, queries, fragments, and
 * userinfo are rejected rather than stripped: a config entry that carries
 * them says the author expected them to matter, and silently ignoring parts
 * of a trust rule is how allowlists rot.
 */
export function normalizeOrigin(entry: string): string | null {
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username !== '' || url.password !== '') return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
  // `https://*.example` parses, and would then match exactly one impossible
  // host while reading like a wildcard. Refusing it is how someone finds out
  // that origins are exact before they trust one that never matches.
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/i.test(url.hostname)) return null
  return url.origin
}

/**
 * Addresses that are not publicly routable: loopback, RFC 1918, link-local
 * (including cloud metadata at 169.254.169.254), CGNAT, benchmark,
 * documentation, multicast, and reserved space; for IPv6 also unspecified,
 * unique-local, site-local, and discard prefixes. IPv4-mapped IPv6 addresses
 * are classified as the IPv4 address they carry.
 */
const NON_PUBLIC = new BlockList()
const PUBLIC_IPV6 = new BlockList()
PUBLIC_IPV6.addSubnet('2000::', 3, 'ipv6')
for (const [subnet, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(subnet, prefix, 'ipv4')
}
for (const [subnet, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 — fail closed rather than trust the embedded address
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32], // Teredo embeds an IPv4 destination
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds an IPv4 address; fail closed
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  // Deliberately no `::ffff:0:0/96` rule: Node checks an IPv4 address against
  // IPv6 rules through its own IPv4-mapped form, so that entry would classify
  // every address on the internet as private. `mappedIpv4` handles the mapped
  // spellings instead.
] as const) {
  NON_PUBLIC.addSubnet(subnet, prefix, 'ipv6')
}

/**
 * The IPv4 address an IPv4-mapped IPv6 address carries, in either spelling:
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address, and only the
 * first would survive being classified as IPv6.
 */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase()
  if (!lower.startsWith('::ffff:')) return null
  const rest = lower.slice('::ffff:'.length)
  if (isIP(rest) === 4) return rest
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest)
  if (hex === null) return null
  const high = Number.parseInt(hex[1]!, 16)
  const low = Number.parseInt(hex[2]!, 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/** Whether one IP literal is publicly routable. */
export function isPublicAddress(address: string): boolean {
  const candidate = mappedIpv4(address) ?? address
  const family = isIP(candidate)
  if (family === 0) return false
  // Fail closed outside the currently allocated global-unicast block. This
  // catches reserved IPv6 space without depending on an inevitably stale
  // enumeration; explicit exclusions below then carve special-use prefixes
  // out of global unicast itself.
  if (family === 6 && !PUBLIC_IPV6.check(candidate, 'ipv6')) return false
  return !NON_PUBLIC.check(candidate, family === 6 ? 'ipv6' : 'ipv4')
}

/** A URL hostname as an address-or-name: IPv6 hosts arrive bracketed. */
function hostnameAddress(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostnameAddress(hostname).toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const family = isIP(host)
  if (family === 4) return host.startsWith('127.')
  if (family === 6) return host === '::1' || /^::ffff:127\./.test(host)
  return false
}

export interface MediaUrlPolicy {
  /**
   * Extra origins remote media may use beyond public HTTPS — the self-host
   * and intranet escape hatch. Entries are normalized origins from
   * User-owned configuration (`media_origins`); a repository cannot supply
   * them.
   */
  allowOrigins: readonly string[]
  /** Test seam; production resolves with the system resolver. */
  lookup?: (hostname: string) => Promise<string[]>
}

type MediaUrlApproval = { ok: true; addresses: readonly string[] }

async function resolveAddresses(
  hostname: string,
  policy: MediaUrlPolicy,
): Promise<string[] | null> {
  if (policy.lookup !== undefined) {
    try {
      return await policy.lookup(hostname)
    } catch {
      return null
    }
  }
  try {
    const results = await dnsLookup(hostname, { all: true, verbatim: true })
    return results.map((entry) => entry.address)
  } catch {
    return null
  }
}

/**
 * Whether one URL is a destination remote media may be fetched from.
 *
 * Default policy: `https` to a host every resolved address of which is
 * publicly routable. A User-allowed origin skips the scheme and address
 * checks — the User said that exact origin is theirs to trust — but nothing
 * skips the userinfo refusal, and every redirect hop is checked again.
 *
 * The approved addresses come back with the verdict rather than being
 * rediscovered later: `fetchMediaUrl` connects to one of exactly these, so a
 * resolver that would answer differently on a second lookup cannot rebind the
 * request onto a private address between the check and the connection.
 */
export async function checkMediaUrl(
  target: URL,
  policy: MediaUrlPolicy,
): Promise<MediaUrlApproval | UrlRefusal> {
  if (target.username !== '' || target.password !== '') {
    return { ok: false, reason: 'Image URLs with embedded credentials are never fetched.' }
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, reason: `Only http(s) image URLs are supported, not ${target.protocol.replace(/:$/, '')}.` }
  }
  const userAllowed = policy.allowOrigins.includes(target.origin)
  const escapeHatch =
    'Remote images use public HTTPS; for a self-hosted or intranet image server, allow its exact origin with `notifai config set media_origins <origin>`.'
  if (!userAllowed && target.protocol !== 'https:') {
    return { ok: false, reason: `${target.origin} is http. ${escapeHatch}` }
  }
  const literal = hostnameAddress(target.hostname)
  if (isIP(literal) !== 0) {
    return userAllowed || isPublicAddress(literal)
      ? { ok: true, addresses: [literal] }
      : { ok: false, reason: `${target.hostname} is not a public address. ${escapeHatch}` }
  }
  const addresses = await resolveAddresses(target.hostname, policy)
  if (addresses === null || addresses.length === 0) {
    return { ok: false, reason: `Could not resolve ${target.hostname}.` }
  }
  if (addresses.some((address) => isIP(address) === 0)) {
    return { ok: false, reason: `${target.hostname} resolved to an invalid address.` }
  }
  if (!userAllowed && !addresses.every((address) => isPublicAddress(address))) {
    return { ok: false, reason: `${target.hostname} resolves to a non-public address. ${escapeHatch}` }
  }
  return { ok: true, addresses }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return headers
}

/**
 * Fetch through one already-vetted address while retaining the URL hostname
 * for Host and TLS verification. This closes the DNS-rebinding gap between
 * policy resolution and the connection: the request cannot resolve the name
 * a second time to a private address.
 */
async function fetchPinned(target: URL, addresses: readonly string[]): Promise<Response> {
  let lastError: unknown = new Error(`No address was available for ${target.hostname}.`)
  for (const address of addresses) {
    try {
      return await new Promise<Response>((resolve, reject) => {
        const family = isIP(address)
        const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
          target,
          {
            method: 'GET',
            headers: { 'accept-encoding': 'identity' },
            signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
            // Node asks for every address at once when it is racing address
            // families, and for a single one otherwise. Answering in the wrong
            // shape throws inside the connect path rather than failing the
            // request, so both forms are answered explicitly.
            lookup: (_hostname, options, callback) => {
              if (options.all === true) {
                callback(null, [{ address, family }])
                return
              }
              callback(null, address, family)
            },
          },
          (incoming) => {
            const status = incoming.statusCode ?? 500
            const hasBody = ![101, 204, 205, 304].includes(status)
            const body = hasBody
              ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
              : null
            resolve(
              new Response(body, {
                status,
                ...(incoming.statusMessage === undefined
                  ? {}
                  : { statusText: incoming.statusMessage }),
                headers: responseHeaders(incoming),
              }),
            )
          },
        )
        request.once('error', reject)
        request.end()
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * Fetch a remote image under the media URL policy, following at most
 * `MEDIA_REDIRECT_LIMIT` redirects and re-validating every hop — a public
 * HTTPS URL redirecting into an intranet is the exact attack the per-hop
 * check exists for.
 */
export async function fetchMediaUrl(
  source: string,
  policy: MediaUrlPolicy,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; response: Response } | UrlRefusal> {
  let target: URL
  try {
    target = new URL(source)
  } catch {
    return { ok: false, reason: `"${source}" is not a valid URL.` }
  }
  for (let hop = 0; ; hop += 1) {
    const allowed = await checkMediaUrl(target, policy)
    if (!allowed.ok) return allowed
    const response =
      fetchImpl === undefined
        ? await fetchPinned(target, allowed.addresses)
        : await fetchImpl(target, { redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response.status)) return { ok: true, response }
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (location === null) {
      return { ok: false, reason: `${target.origin} redirected without a destination.` }
    }
    if (hop >= MEDIA_REDIRECT_LIMIT) {
      return { ok: false, reason: `${source} redirected more than ${MEDIA_REDIRECT_LIMIT} times.` }
    }
    try {
      target = new URL(location, target)
    } catch {
      return { ok: false, reason: `${target.origin} redirected to an invalid URL.` }
    }
  }
}

/**
 * Whether a server-supplied pairing approval URL may be shown and opened.
 *
 * The server chooses `approve_url`, so a compromised or misconfigured one
 * must not be able to drive this machine's browser to an arbitrary
 * destination. Allowed: the canonical dashboard, the exact origin the user
 * pointed this pairing at, loopback for local development, and origins the
 * User allowed (`approve_origins`) for a self-host whose dashboard lives on
 * a different origin than its API.
 */
export function checkApproveUrl(
  raw: string,
  baseUrl: string,
  allowOrigins: readonly string[],
): { ok: true } | UrlRefusal {
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return { ok: false, reason: `the server sent an invalid approval URL.` }
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return {
      ok: false,
      reason: `the server sent a ${target.protocol.replace(/:$/, '')} approval URL; only http(s) is ever opened.`,
    }
  }
  if (target.username !== '' || target.password !== '') {
    return { ok: false, reason: 'the server sent an approval URL with embedded credentials.' }
  }
  if (target.origin === CANONICAL_DASHBOARD_ORIGIN) return { ok: true }
  if (isLoopbackHostname(target.hostname)) return { ok: true }
  let pairingOrigin: string | null = null
  try {
    pairingOrigin = new URL(baseUrl).origin
  } catch {
    pairingOrigin = null
  }
  if (allowOrigins.includes(target.origin)) return { ok: true }
  if (
    pairingOrigin !== null &&
    target.origin === pairingOrigin &&
    target.protocol === 'https:'
  ) {
    return { ok: true }
  }
  return {
    ok: false,
    reason:
      `the server sent an approval URL on ${target.origin}, which is not the Notifai dashboard, ` +
      'the origin being paired with, loopback, or an origin in `approve_origins`.',
  }
}
