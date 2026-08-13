import { execFileSync } from 'node:child_process'

/**
 * @param {string} root
 * @param {string[]} args
 */
export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd()
}

/**
 * @param {string} root
 */
export function gitRoot(root) {
  return git(root, ['rev-parse', '--show-toplevel'])
}

/**
 * @param {string} root
 */
export function isClean(root) {
  return git(root, ['status', '--porcelain']) === ''
}

/**
 * @param {string} root
 * @param {string} pattern
 * @returns {string | null}
 */
export function latestTag(root, pattern) {
  try {
    const tags = git(root, ['tag', '--list', pattern, '--sort=-v:refname'])
    if (tags === '') return null
    return tags.split('\n')[0] ?? null
  } catch {
    return null
  }
}

/**
 * Commit that last introduced `version` into a manifest. Used as the
 * baseline when a package has never had its own tag.
 *
 * @param {string} root
 * @param {string} manifest
 * @param {string} version
 * @returns {string | null}
 */
export function versionIntroducedAt(root, manifest, version) {
  try {
    const sha = git(root, ['log', '-1', '--format=%H', '-S', `"version": "${version}"`, '--', manifest])
    return sha === '' ? null : sha
  } catch {
    return null
  }
}

/**
 * @param {string} root
 * @param {{ from: string | null, to?: string }} range
 * @returns {{ sha: string, subject: string, body: string, files: string[] }[]}
 */
export function listCommits(root, range) {
  const spec = range.from ? `${range.from}..${range.to ?? 'HEAD'}` : (range.to ?? 'HEAD')
  const raw = execFileSync('git', ['log', '--reverse', '--no-merges', '--name-only', '--format=%n%x1e%H%x1f%s%x1f%b%x1f', spec], {
    cwd: root,
    encoding: 'utf8',
  })
  const records = raw.split('\x1e').map((chunk) => chunk.replace(/^\n/, '')).filter((chunk) => chunk.trim() !== '')
  const commits = []
  for (const record of records) {
    const [sha, subject, rest] = splitn(record, '\x1f', 3)
    if (!sha || subject === undefined) continue
    const [body, filesBlock] = splitn(rest ?? '', '\x1f', 2)
    const files = (filesBlock ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    commits.push({ sha, subject, body: (body ?? '').trim(), files })
  }
  return commits
}

function splitn(text, sep, n) {
  const parts = []
  let remaining = text
  for (let i = 0; i < n - 1; i += 1) {
    const at = remaining.indexOf(sep)
    if (at === -1) {
      parts.push(remaining)
      return parts
    }
    parts.push(remaining.slice(0, at))
    remaining = remaining.slice(at + sep.length)
  }
  parts.push(remaining)
  return parts
}
