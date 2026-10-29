/** Contract-valid Project slug, or null when the name has no safe characters. */
export function projectSlugFrom(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, '')
    .slice(0, 64)
  return slug.length > 0 && /^[a-z0-9]/.test(slug) ? slug : null
}
