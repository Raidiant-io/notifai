import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What this build is, according to the manifest npm actually shipped.
 *
 * Read from disk rather than compiled in, because a constant baked into
 * `dist/` is only ever as fresh as the last build. A stale `dist/` sitting
 * next to a newer `package.json` is a real failure mode — it produces a CLI
 * that reports the new version perfectly while running the old code — and the
 * only defence that survives it is refusing to carry a second copy of the
 * number at all.
 *
 * The manifest sits one level above both `src/` and `dist/`, so a single
 * relative path resolves in a source checkout and in a published install.
 *
 * Returns null rather than guessing: a build that cannot establish its own
 * identity has to say so, so callers can degrade honestly instead of
 * asserting something they do not know.
 */
export function packageVersion(): string | null {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const { version } = parsed as { version?: unknown }
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch {
    // Fall through: an unreadable manifest must not stop the CLI running.
  }
  return null
}

/**
 * Where `npx skills add` fetches the agent skill from, as printed to users.
 *
 * The human-readable release tag naming this exact build. The installer does
 * not trust this ref: it verifies the tag's complete skill tree against the
 * content manifest shipped in npm and then installs from the resolved commit
 * SHA. Deriving the label from the version keeps release identity from
 * drifting; it used to be maintained by hand in three places.
 *
 * In the skills CLI grammar `owner/repo#ref` selects a Git ref, while
 * `owner/repo@name` selects a skill — so the `#` here is load-bearing.
 */
export function skillsSource(): string | null {
  const version = packageVersion()
  return version === null ? null : `Raidiant-io/notifai#v${version}`
}
