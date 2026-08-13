/**
 * The two published packages and how commits map onto them.
 *
 * `skill` is not a package. It ships inside the CLI tag (SKILLS_SOURCE is
 * derived from the CLI version), so a skill-scoped commit bumps `@raidiant/notifai`.
 */

export const PACKAGES = Object.freeze([
  {
    id: 'cli',
    name: '@raidiant/notifai',
    directory: 'apps/cli',
    manifest: 'apps/cli/package.json',
    changelog: 'apps/cli/CHANGELOG.md',
    tag: (version) => `v${version}`,
    paths: ['apps/cli/', 'skills/'],
    scopes: ['cli', 'skill'],
  },
  {
    id: 'protocol',
    name: '@raidiant/notifai-protocol',
    directory: 'packages/protocol',
    manifest: 'packages/protocol/package.json',
    changelog: 'packages/protocol/CHANGELOG.md',
    tag: (version) => `protocol-v${version}`,
    paths: ['packages/protocol/'],
    scopes: ['protocol'],
  },
])

export const COMPARE_REPO = 'https://github.com/Raidiant-io/notifai'

/**
 * @param {{ scope: string | null, files: string[] }} commit
 * @returns {Set<string>}
 */
export function packagesFor(commit) {
  const ids = new Set()
  if (commit.scope && commit.scope !== 'repo') {
    for (const pkg of PACKAGES) {
      if (pkg.scopes.includes(commit.scope)) ids.add(pkg.id)
    }
  }
  for (const file of commit.files) {
    for (const pkg of PACKAGES) {
      if (pkg.paths.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix))) {
        ids.add(pkg.id)
      }
    }
  }
  return ids
}

export function compareUrl(tagFrom, tagTo) {
  if (tagFrom === null) return `${COMPARE_REPO}/releases/tag/${tagTo}`
  return `${COMPARE_REPO}/compare/${tagFrom}...${tagTo}`
}

export function unreleasedUrl(tagTo) {
  return `${COMPARE_REPO}/compare/${tagTo}...HEAD`
}
