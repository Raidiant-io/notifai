/**
 * A body may reference an attached image only through Markdown image syntax:
 * `![what it shows](media:1)` for a position in `--image` order, or
 * `![…](media:med_…)` for an id that is also attached. Companions resolve
 * the `media:` scheme only as an image target; a bare token or a link would
 * reach the User as raw text, so both are refused here rather than rendered
 * wrongly there.
 */
const MEDIA_IMAGE_REFERENCE =
  /!\[[^\]\n]*\]\(\s*<?media:([^\s)>]*)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)/g
/** A stray `media:` token outside image syntax: a position or a media id. */
const STRAY_MEDIA_REFERENCE = /media:(?:\d+(?![A-Za-z0-9_-])|med_[A-Za-z0-9_-]+)/

/** Inspect image destinations, including nested parentheses and reference-style
 * images. Only inline media images render consistently across Companion Apps.
 * Ordinary links and escaped image syntax remain prose. Code is split earlier.
 */
function unsupportedImageTarget(prose: string): string | null {
  for (let start = 0; start < prose.length; start += 1) {
    if (prose[start] === '\\') { start += 1; continue }
    if (!prose.startsWith('![', start)) continue
    let cursor = start + 2
    let brackets = 1
    for (; cursor < prose.length && brackets > 0; cursor += 1) {
      if (prose[cursor] === '\\') { cursor += 1; continue }
      if (prose[cursor] === '[') brackets += 1
      if (prose[cursor] === ']') brackets -= 1
    }
    if (brackets !== 0) continue
    if (prose[cursor] !== '(') {
      // Reference-style and shortcut images are not an inline media reference.
      return prose.slice(start, cursor)
    }
    const destinationStart = cursor + 1
    let parentheses = 1
    let angle = false
    for (cursor += 1; cursor < prose.length && parentheses > 0; cursor += 1) {
      const character = prose[cursor]
      if (character === '\\') { cursor += 1; continue }
      if (character === '<') angle = true
      if (character === '>') angle = false
      if (!angle && character === '(') parentheses += 1
      if (!angle && character === ')') parentheses -= 1
    }
    if (parentheses !== 0) continue
    const destination = prose.slice(destinationStart, cursor - 1).trim()
    const target = destination.startsWith('<')
      ? destination.slice(1, destination.indexOf('>'))
      : destination.split(/\s/, 1)[0]!
    if (!target.startsWith('media:')) return target || '(empty image destination)'
    start = cursor - 1
  }
  return null
}

type ProseSegment = { text: string; code: boolean }

/** Split Markdown into literal code (fences and spans) and the prose around it. */
function markdownProseSegments(body: string): ProseSegment[] {
  const segments: ProseSegment[] = []
  let fence: { marker: string; length: number } | null = null
  let prose = ''
  let code = ''
  const flushProse = () => {
    if (prose.length === 0) return
    segments.push(...inlineCodeSegments(prose))
    prose = ''
  }
  // Keep each line's own newline so the segments concatenate back to the body.
  for (const line of body.split(/(?<=\n)/)) {
    if (fence !== null) {
      code += line
      const close = line.trim().match(/^(`{3,}|~{3,})\s*$/)
      if (close?.[1]?.[0] === fence.marker && close[1].length >= fence.length) {
        segments.push({ text: code, code: true })
        code = ''
        fence = null
      }
      continue
    }
    const open = line.trim().match(/^(`{3,}|~{3,})/)
    if (open?.[1]) {
      flushProse()
      fence = { marker: open[1][0]!, length: open[1].length }
      code = line
      continue
    }
    prose += line
  }
  flushProse()
  if (code.length > 0) segments.push({ text: code, code: true })
  return segments
}

/** Split prose at backtick spans so a literal `media:1` in code stays literal. */
function inlineCodeSegments(prose: string): ProseSegment[] {
  const segments: ProseSegment[] = []
  let cursor = 0
  const runs = /`+/g
  let match: RegExpExecArray | null
  while ((match = runs.exec(prose)) !== null) {
    const open = match[0]
    const closeIndex = prose.indexOf(open, match.index + open.length)
    if (closeIndex === -1) continue
    const end = closeIndex + open.length
    if (match.index > cursor) segments.push({ text: prose.slice(cursor, match.index), code: false })
    segments.push({ text: prose.slice(match.index, end), code: true })
    cursor = end
    runs.lastIndex = end
  }
  if (cursor < prose.length) segments.push({ text: prose.slice(cursor), code: false })
  return segments
}

/**
 * Rewrite authorable 1-based media positions to canonical ready media ids and
 * refuse every other shape of media reference before anything is sent.
 */
export function rewriteMediaReferences(
  body: string,
  mediaIds: readonly string[],
  { allowPositions = true }: { allowPositions?: boolean } = {},
): { ok: true; body: string } | { ok: false; error: string } {
  let error: string | undefined
  const rewritten = markdownProseSegments(body)
    .map((segment) => {
      if (segment.code || error !== undefined) return segment.text
      const unsupported = unsupportedImageTarget(segment.text)
      if (unsupported !== null) {
        error = `Body image reference "${unsupported}" cannot be displayed. ` +
          'Pass the URL or file with --image and reference it as ![what it shows](media:1) (media:N in --image order).'
        return segment.text
      }
      const images: string[] = []
      // Choose a marker absent from authored text. A fixed private-use
      // character lets input such as `\uE0000\uE000` impersonate a placeholder
      // and duplicate an image reference during restoration.
      let imageMarker = '\uE000'
      while (segment.text.includes(imageMarker)) imageMarker += '\uE000'
      const masked = segment.text.replace(MEDIA_IMAGE_REFERENCE, (reference, target: string) => {
        if (error !== undefined) return reference
        let mediaId: string | undefined
        if (/^\d+$/.test(target)) {
          if (!allowPositions) {
            error = `Body reference "media:${target}" must be resolved to an attached media id before submission; use --image and ![what it shows](media:1) with the CLI.`
            return reference
          }
          const position = Number(target)
          mediaId = String(position) === target ? mediaIds[position - 1] : undefined
          if (mediaId === undefined) {
            error = `Body reference "media:${target}" has no matching --image occurrence.`
            return reference
          }
        } else if (/^med_[A-Za-z0-9_-]+$/.test(target)) {
          if (!mediaIds.includes(target)) {
            error = `Body reference "media:${target}" is not attached; pass it with --image.`
            return reference
          }
          mediaId = target
        } else {
          error = `Body reference "media:${target}" is neither an --image position nor a media id.`
          return reference
        }
        images.push(reference.replace(`media:${target}`, `media:${mediaId}`))
        return `${imageMarker}${images.length - 1}${imageMarker}`
      })
      if (error !== undefined) return segment.text
      const stray = masked.match(STRAY_MEDIA_REFERENCE)
      if (stray !== null) {
        error =
          `Body reference "${stray[0]}" is not a Markdown image. Write ` +
          `![what it shows](${stray[0]}) — a bare or linked media reference is never rendered.`
        return segment.text
      }
      return images.reduce(
        (restored, image, index) => restored.replaceAll(`${imageMarker}${index}${imageMarker}`, image),
        masked,
      )
    })
    .join('')
  return error === undefined ? { ok: true, body: rewritten } : { ok: false, error }
}

