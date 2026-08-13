/**
 * Conventional Commits 1.0.0, narrowed to the types and scopes this
 * repository will accept. Unknown types are a lint failure, not a silent
 * ignore: an agent that typed `feature:` should be told the word is `feat`,
 * not have the commit vanish from the next release.
 *
 * Spec: https://www.conventionalcommits.org/en/v1.0.0/
 */

export const TYPES = Object.freeze(['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'ci', 'revert'])
export const SCOPES = Object.freeze(['cli', 'protocol', 'skill', 'repo'])

const HEADER = /^([A-Za-z]+)(?:\(([A-Za-z0-9-]+)\))?(!)?: (.*)$/
const FOOTER = /^(BREAKING CHANGE|BREAKING-CHANGE|[A-Z][A-Za-z0-9-]+)(: | #)(.*)$/
const PRIVATE_ID = /\bNotifAI-[a-z0-9]+\b|\b(?:AD|D|U)-\d{2,}\b/

export const HELP = `Conventional commit:

  <type>(<scope>)!: <description>

Types:  ${TYPES.join(', ')}
Scopes: ${SCOPES.join(', ')}  (optional — omit to infer from the paths you touched)
Break:  feat(cli)!: remove the presence gate
        or a footer: BREAKING CHANGE: require_idle is gone

Description is the public-audience sentence this repo already writes.
No tracker IDs, no trailing period.

Examples:
  feat(cli): wake Claude sessions through the inbox socket
  fix(protocol): reject an empty question set
  chore: derive the skill pin from the package version`

/**
 * @typedef {{
 *   type: string,
 *   scope: string | null,
 *   breaking: boolean,
 *   description: string,
 *   body: string,
 *   footers: { token: string, value: string }[],
 * }} ParsedCommit
 */

/**
 * @param {string} message
 * @returns {{ ok: true, commit: ParsedCommit } | { ok: false, errors: string[] }}
 */
export function parseCommit(message) {
  const errors = []
  const trimmed = message.replace(/^﻿/, '').replace(/\r\n/g, '\n').trimEnd()
  if (trimmed.trim() === '') {
    return fail(['commit message is empty', HELP])
  }

  const paragraphs = trimmed.split('\n')
  const header = paragraphs[0] ?? ''
  const match = HEADER.exec(header)
  if (!match) {
    errors.push(`first line is not a conventional commit: ${JSON.stringify(header)}`)
    errors.push(HELP)
    return fail(errors)
  }

  const typeRaw = match[1]
  const scopeRaw = match[2] ?? null
  const bang = match[3] === '!'
  const description = match[4] ?? ''
  const type = typeRaw.toLowerCase()
  const scope = scopeRaw === null ? null : scopeRaw.toLowerCase()

  if (type !== typeRaw) errors.push(`type must be lowercase (${type}, not ${typeRaw})`)
  if (scopeRaw !== null && scope !== scopeRaw) {
    errors.push(`scope must be lowercase (${scope}, not ${scopeRaw})`)
  }
  if (!TYPES.includes(type)) {
    errors.push(`unknown type ${JSON.stringify(typeRaw)} — use one of: ${TYPES.join(', ')}`)
  }
  if (scope !== null && !SCOPES.includes(scope)) {
    errors.push(`unknown scope ${JSON.stringify(scopeRaw)} — use one of: ${SCOPES.join(', ')}, or omit it`)
  }
  if (description.trim() === '') errors.push('description is empty')
  if (description !== description.trim()) errors.push('description has leading or trailing whitespace')
  if (/[.]$/.test(description)) errors.push('description must not end with a period')
  if (PRIVATE_ID.test(trimmed)) {
    errors.push('public commits cannot name internal tracker IDs (NotifAI-*, D-###, U-###, AD-###)')
  }

  const rest = paragraphs.slice(1)
  if (rest.length > 0 && rest[0] !== '') {
    errors.push('a blank line must separate the subject from the body')
  }

  const { body, footers, footerErrors } = splitFooters(rest)
  errors.push(...footerErrors)

  const breakingFooter = footers.some((footer) => footer.token === 'BREAKING CHANGE' || footer.token === 'BREAKING-CHANGE')
  if (errors.length > 0) return fail(errors)

  return {
    ok: true,
    commit: {
      type,
      scope,
      breaking: bang || breakingFooter,
      description,
      body,
      footers,
    },
  }
}

/**
 * @param {string} message
 * @returns {string[]}
 */
export function lintCommit(message) {
  const parsed = parseCommit(message)
  return parsed.ok ? [] : parsed.errors
}

/**
 * True when the first line is trying to be a conventional commit.
 * Prose history (everything before this machine) is not an attempt.
 *
 * @param {string} message
 */
export function looksConventional(message) {
  const header = message.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')[0] ?? ''
  return HEADER.test(header)
}

function splitFooters(lines) {
  const errors = []
  const start = lines[0] === '' ? 1 : 0
  const content = lines.slice(start)

  let footerAt = -1
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '' && content[i + 1] !== undefined && FOOTER.test(content[i + 1])) {
      footerAt = i + 1
      break
    }
    if (i === 0 && FOOTER.test(content[i]) && !content.slice(0, i).some((line) => line !== '')) {
      footerAt = 0
      break
    }
  }

  // A body-less message may start footers after the required blank line.
  if (footerAt === -1) {
    const firstFooter = content.findIndex((line) => FOOTER.test(line))
    if (firstFooter > 0 && content[firstFooter - 1] === '') footerAt = firstFooter
    else if (firstFooter === 0) footerAt = 0
  }

  const bodyLines = footerAt === -1 ? content : content.slice(0, footerAt)
  const footerLines = footerAt === -1 ? [] : content.slice(footerAt)
  const footers = []
  let current = null
  for (const line of footerLines) {
    const match = FOOTER.exec(line)
    if (match) {
      if (current) footers.push(current)
      current = { token: match[1], value: match[3] }
      continue
    }
    if (current && (line.startsWith(' ') || line.startsWith('\t'))) {
      current.value = `${current.value}\n${line.trim()}`
      continue
    }
    if (line === '' && current) continue
    errors.push(`could not parse footer line: ${JSON.stringify(line)}`)
  }
  if (current) footers.push(current)

  return {
    body: bodyLines.join('\n').trim(),
    footers,
    footerErrors: errors,
  }
}

function fail(errors) {
  return { ok: false, errors }
}
