/**
 * Keep a Changelog 1.1.0 writer.
 *
 * Commits are the source of the next section. An existing [Unreleased]
 * block is merged in (human notes sit above generated bullets) and then
 * cleared. Empty KaC groups are omitted.
 *
 * Spec: https://keepachangelog.com/en/1.1.0/
 */

export const SECTIONS = Object.freeze(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'])

const INTRO = `# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`

/**
 * @param {{ type: string, breaking: boolean, description: string }} commit
 * @returns {string | null}
 */
export function sectionFor(commit) {
  const text = commit.description
  if (commit.breaking && /^(remove|delete|drop)\b/i.test(text)) return 'Removed'
  if (commit.breaking) return 'Changed'
  if (commit.type === 'feat') return 'Added'
  if (commit.type === 'fix' && /\bsecurity\b/i.test(text)) return 'Security'
  if (commit.type === 'fix') return 'Fixed'
  return null
}

/**
 * @param {Iterable<{ type: string, breaking: boolean, description: string }>} commits
 * @returns {Record<string, string[]>}
 */
export function groupChanges(commits) {
  /** @type {Record<string, string[]>} */
  const groups = Object.fromEntries(SECTIONS.map((name) => [name, []]))
  const seen = new Set()
  for (const commit of commits) {
    const section = sectionFor(commit)
    if (section === null) continue
    const bullet = commit.breaking && !/^\*\*BREAKING\*\*/i.test(commit.description)
      ? `**BREAKING** ${commit.description}`
      : commit.description
    const key = `${section}\n${bullet}`
    if (seen.has(key)) continue
    seen.add(key)
    groups[section].push(bullet)
  }
  return groups
}

/**
 * @param {{
 *   version: string,
 *   date: string,
 *   groups: Record<string, string[]>,
 *   extra?: Record<string, string[]>,
 * }} entry
 */
export function renderSection(entry) {
  const groups = mergeGroups(entry.extra ?? {}, entry.groups)
  const parts = [`## [${entry.version}] - ${entry.date}`]
  for (const name of SECTIONS) {
    const items = groups[name] ?? []
    if (items.length === 0) continue
    parts.push('', `### ${name}`, ...items.map((item) => `- ${item}`))
  }
  if (parts.length === 1) parts.push('', '### Changed', '- Release engineering only.')
  return `${parts.join('\n')}\n`
}

/**
 * Insert a new version section after [Unreleased], merging any handwritten
 * Unreleased bullets into the new section and leaving Unreleased empty.
 *
 * @param {string} existing
 * @param {{
 *   version: string,
 *   date: string,
 *   groups: Record<string, string[]>,
 *   compareUrl: (from: string | null, to: string) => string,
 *   unreleasedUrl: (to: string) => string,
 * }} entry
 */
export function upsertChangelog(existing, entry) {
  const source = existing.trim() === '' ? defaultDocument() : existing.replace(/\r\n/g, '\n')
  const parsed = splitDocument(source)
  const extra = parseUnreleased(parsed.unreleased)
  const section = renderSection({ version: entry.version, date: entry.date, groups: entry.groups, extra })
  const versions = parsed.versions.filter((block) => !block.startsWith(`## [${entry.version}]`))
  const links = updateLinks(parsed.links, entry)
  return [parsed.intro.trimEnd(), '', '## [Unreleased]', '', section, ...versions, '', links].join('\n').replace(/\n{3,}/g, '\n\n')
}

export function defaultDocument() {
  return `${INTRO}\n## [Unreleased]\n`
}

function splitDocument(source) {
  const linkAt = source.search(/\n\[[^\]]+\]:\s+http/)
  const body = linkAt === -1 ? source : source.slice(0, linkAt)
  const links = linkAt === -1 ? '' : source.slice(linkAt).trim()
  const unreleasedMatch = body.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/)
  const unreleased = unreleasedMatch ? unreleasedMatch[1] : ''
  const afterUnreleased = unreleasedMatch
    ? body.slice((unreleasedMatch.index ?? 0) + unreleasedMatch[0].length)
    : body.replace(/^[\s\S]*?(?=\n## \[|$)/, '')
  const introMatch = body.match(/^[\s\S]*?(?=\n## \[Unreleased\]|\n## \[|$)/)
  const versions = [...afterUnreleased.matchAll(/## \[[^\]]+\][\s\S]*?(?=\n## \[|$)/g)].map((match) => match[0].trim())
  return {
    intro: (introMatch?.[0] ?? INTRO).trim() === '' ? INTRO : (introMatch?.[0] ?? INTRO),
    unreleased,
    versions,
    links,
  }
}

function parseUnreleased(block) {
  /** @type {Record<string, string[]>} */
  const groups = Object.fromEntries(SECTIONS.map((name) => [name, []]))
  let current = null
  for (const line of block.split('\n')) {
    const heading = /^### (.+)$/.exec(line)
    if (heading && SECTIONS.includes(heading[1])) {
      current = heading[1]
      continue
    }
    const bullet = /^- (.+)$/.exec(line)
    if (bullet && current) groups[current].push(bullet[1])
  }
  return groups
}

function mergeGroups(extra, generated) {
  /** @type {Record<string, string[]>} */
  const merged = {}
  for (const name of SECTIONS) {
    const items = [...(extra[name] ?? []), ...(generated[name] ?? [])]
    merged[name] = [...new Set(items)]
  }
  return merged
}

function updateLinks(existing, entry) {
  const lines = existing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('[unreleased]:') && !line.startsWith(`[${entry.version}]:`))
  const previous = previousVersion(lines)
  const next = [
    `[unreleased]: ${entry.unreleasedUrl(entry.version)}`,
    `[${entry.version}]: ${entry.compareUrl(previous, entry.version)}`,
    ...lines,
  ]
  return next.join('\n') + '\n'
}

function previousVersion(linkLines) {
  for (const line of linkLines) {
    const match = /^\[(\d+\.\d+\.\d+)\]:/.exec(line)
    if (match) return match[1]
  }
  return null
}
