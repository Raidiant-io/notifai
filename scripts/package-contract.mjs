import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function packageContract(directory) {
  const manifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, directory, 'package.json'), 'utf8'),
  )
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`${directory}/package.json has no package name`)
  }
  return Object.freeze({ name: manifest.name, directory })
}

export const CLI_PACKAGE = packageContract('apps/cli')
export const PROTOCOL_PACKAGE = packageContract('packages/protocol')
export const PUBLISHABLE_PACKAGES = Object.freeze([CLI_PACKAGE, PROTOCOL_PACKAGE])
