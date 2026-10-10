#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export function supportsTrustedPublishing(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (match === null) return false

  const installed = match.slice(1).map(Number)
  const minimum = [11, 5, 1]
  for (let index = 0; index < minimum.length; index += 1) {
    if (installed[index] !== minimum[index]) return installed[index] > minimum[index]
  }
  return true
}

export function supportsTrustedDistTags(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) return false
  const [major, minor] = match.slice(1).map(Number)
  return (major === 11 && minor >= 21) || (major === 12 && minor >= 2) || major > 12
}
function main() {
  const version = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
  if (process.argv.includes('--dist-tags') && !supportsTrustedDistTags(version)) {
    throw new Error('OIDC dist-tag promotion requires npm 11.21.0 or npm 12.2.0 or newer on their respective release lines')
  }
  if (!supportsTrustedPublishing(version)) {
    throw new Error('trusted publishing requires npm 11.5.1 or newer')
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
