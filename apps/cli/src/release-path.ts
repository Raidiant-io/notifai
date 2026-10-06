/** Archive paths have one portable spelling on all supported filesystems. */
export function releaseMaterialPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 240 || value.split('/').length > 8) return false
  return value.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) &&
    !part.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
}
