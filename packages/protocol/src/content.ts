export const BODY_MAX_LENGTH = 16 * 1024
export const BANNER_EXCERPT_MAX_LENGTH = 300
export const BANNER_EXCERPT_EMPTY_FALLBACK = 'More in the app.'

type Fence = { marker: '`' | '~'; length: number }

function openingFence(line: string): Fence | null {
  const match = line.trim().match(/^(`{3,}|~{3,})/)
  if (!match?.[1]) return null
  return { marker: match[1][0] as Fence['marker'], length: match[1].length }
}

function closesFence(line: string, fence: Fence): boolean {
  const match = line.trim().match(/^(`{3,}|~{3,})\s*$/)
  return match?.[1]?.[0] === fence.marker && match[1].length >= fence.length
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.startsWith('|')) return true
  return trimmed.includes('-') && /^[|:\- ]+$/.test(trimmed)
}

function isThematicBreak(line: string): boolean {
  const compact = line.trim().replaceAll(' ', '')
  return /^-{3,}$/.test(compact) || /^\*{3,}$/.test(compact) || /^_{3,}$/.test(compact)
}

function stripBlockMarkers(line: string): string {
  let value = line.trim()
  let previous = ''
  while (value !== previous) {
    previous = value
    value = value
      .replace(/^#{1,6}[ \t]+/, '')
      .replace(/^>[ \t]+/, '')
      .replace(/^[-*+][ \t]+/, '')
      .replace(/^\d{1,3}[.)][ \t]+/, '')
      .replace(/^\[(?: |x|X)\][ \t]+/, '')
      .trimStart()
  }
  return value
}

function stripPairedEmphasis(value: string): string {
  let next = value
  let previous = ''
  while (next !== previous) {
    previous = next
    next = next
      .replace(/\*\*(?=\S)(.+?\S)\*\*/g, '$1')
      .replace(/__(?=\S)(.+?\S)__/g, '$1')
      .replace(/~~(?=\S)(.+?\S)~~/g, '$1')
      .replace(/(^|[^*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1$2')
      .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?![\w_])/g, '$1$2')
  }
  return next
}

function plainTextLine(line: string): string {
  const withoutMarkers = stripBlockMarkers(line)
  const transformed = withoutMarkers
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/(`+)(.*?)\1/g, '$2')
  return stripPairedEmphasis(transformed).replace(/[ \t]+/g, ' ').trim()
}

function truncateExcerpt(value: string): string {
  const characters = Array.from(value)
  if (characters.length <= BANNER_EXCERPT_MAX_LENGTH) return value

  const bounded = characters.slice(0, BANNER_EXCERPT_MAX_LENGTH)
  let whitespace = -1
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    if (/\s/u.test(bounded[index]!)) {
      whitespace = index
      break
    }
  }
  const cut = whitespace > 0 ? bounded.slice(0, whitespace) : bounded
  return `${cut.join('').trimEnd()}…`
}

/**
 * Derive a native banner's plain-text body from the one canonical Markdown body.
 *
 * This deliberately uses a small deterministic transform rather than a full
 * CommonMark parser. It is wire behavior shared by pre-flight validation,
 * rendering, and regression fixtures.
 */
export function bannerExcerpt(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const visible: string[] = []
  let fence: Fence | null = null

  for (const line of lines) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null
      continue
    }
    const opened = openingFence(line)
    if (opened !== null) {
      fence = opened
      continue
    }
    if (isTableLine(line) || isThematicBreak(line)) continue
    const plain = plainTextLine(line)
    if (plain.length > 0) visible.push(plain)
  }

  const excerpt = visible.join('\n')
  return excerpt.length === 0 ? BANNER_EXCERPT_EMPTY_FALLBACK : truncateExcerpt(excerpt)
}
