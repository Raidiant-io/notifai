import { groupChanges } from './changelog.mjs'
import { parseCommit } from './conventional-commit.mjs'
import { PACKAGES, packagesFor } from './packages.mjs'
import { bumpFromCommits, bumpVersion } from './semver-policy.mjs'

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   from: string,
 *   to: string,
 *   bump: 'major' | 'minor' | 'patch' | null,
 *   tag: string,
 *   baseline: string | null,
 *   changelog: string,
 *   directory: string,
 *   groups: Record<string, string[]>,
 *   commits: { sha: string, type: string, breaking: boolean, description: string }[],
 * }} PackagePlan
 */

/**
 * @param {{
 *   packages: { id: string, version: string }[],
 *   commits: { sha: string, subject: string, body: string, files: string[] }[],
 *   baselines: Record<string, string | null>,
 *   only?: string[],
 * }} input
 */
export function planRelease(input) {
  const wanted = input.only ? new Set(input.only) : null
  const errors = []
  const parsed = []

  for (const raw of input.commits) {
    const message = raw.body === '' ? raw.subject : `${raw.subject}\n\n${raw.body}`
    const result = parseCommit(message)
    if (!result.ok) {
      errors.push(`${raw.sha.slice(0, 7)} ${raw.subject}\n    ${result.errors[0]}`)
      continue
    }
    parsed.push({ ...result.commit, sha: raw.sha, files: raw.files })
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: [
        'every commit since the last release must be a conventional commit.',
        'rewrite the offenders with `git commit --amend` or `git rebase -i`, then rerun.',
        '',
        ...errors,
      ],
      packages: [],
    }
  }

  /** @type {PackagePlan[]} */
  const packages = []
  for (const spec of PACKAGES) {
    if (wanted && !wanted.has(spec.id)) continue
    const current = input.packages.find((pkg) => pkg.id === spec.id)
    if (!current) {
      return { ok: false, errors: [`missing current version for ${spec.id}`], packages: [] }
    }
    const owned = parsed.filter((commit) => packagesFor(commit).has(spec.id))
    const bump = bumpFromCommits(owned, current.version)
    const to = bump === null ? current.version : bumpVersion(current.version, bump)
    packages.push({
      id: spec.id,
      name: spec.name,
      from: current.version,
      to,
      bump,
      tag: spec.tag(to),
      baseline: input.baselines[spec.id] ?? null,
      changelog: spec.changelog,
      directory: spec.directory,
      groups: groupChanges(owned),
      commits: owned.map((commit) => ({
        sha: commit.sha,
        type: commit.type,
        breaking: commit.breaking,
        description: commit.description,
      })),
    })
  }

  return { ok: true, errors: [], packages }
}
