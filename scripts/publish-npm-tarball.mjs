#!/usr/bin/env node
// Publish one admitted tarball with OIDC provenance. Repeat only the one
// failure proven to leave the registry untouched: a Sigstore Rekor conflict.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

// npm signs provenance before it uploads the package. Its Sigstore client
// retries a timed-out Rekor upload itself; when the first upload had landed,
// the retry gets 409 and npm aborts before any registry write. A new publish
// signs with a fresh ephemeral key, so its log entry cannot collide.
export const REKOR_CONFLICT = /\bTLOG_CREATE_ENTRY_ERROR\b[\s\S]*\(409\) an equivalent entry already exists in the transparency log/
export const PUBLISH_ATTEMPTS = 3
const RETRY_DELAY_MS = 15_000

export async function registryHasVersion(name, version, fetchImpl = fetch) {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache' } })
  if (response.status === 404) return false
  if (response.status === 200) return true
  throw new Error(`npm registry lookup failed (HTTP ${response.status})`)
}

export async function publishTarball({ tarball, distTag, name, version,
  run = args => spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
  registryHas = registryHasVersion, wait = delay, log = message => console.error(message), attempts = PUBLISH_ATTEMPTS }) {
  assert.ok(tarball && distTag && name && version, 'Publication needs the tarball, dist-tag, package name and version')
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = run(['publish', tarball, '--access', 'public', '--provenance', '--tag', distTag])
    process.stdout.write(String(result.stdout ?? ''))
    process.stderr.write(String(result.stderr ?? ''))
    if (!result.error && result.status === 0) return { published: true, attempts: attempt }
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    if (result.error || result.signal || !REKOR_CONFLICT.test(output)) {
      throw new Error(`npm publish failed (${result.error?.code ?? result.signal ?? `exit ${result.status}`})`)
    }
    // Prove the registry did not receive this version before publishing again.
    if (await registryHas(name, version)) {
      log(`npm publish reported a Sigstore Rekor 409 conflict, but ${name}@${version} is on the registry; the published-bytes check decides.`)
      return { published: true, attempts: attempt }
    }
    if (attempt === attempts) break
    log(`npm publish hit Sigstore Rekor 409 TLOG_CREATE_ENTRY_ERROR before uploading; ${name}@${version} is not on the registry. ` +
      `Publishing again with a fresh signing identity in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1} of ${attempts}).`)
    await wait(RETRY_DELAY_MS)
  }
  throw new Error(`npm publish kept hitting Sigstore Rekor 409 conflicts after ${attempts} attempts; ${name}@${version} was not published`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [tarball, distTag, name, version] = process.argv.slice(2)
  publishTarball({ tarball, distTag, name, version }).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
