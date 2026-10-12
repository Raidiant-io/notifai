import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function packageContract(sourceDirectory, directory = sourceDirectory) {
  const manifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, sourceDirectory, 'package.json'), 'utf8'),
  )
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`${sourceDirectory}/package.json has no package name`)
  }
  return Object.freeze({ name: manifest.name, directory, sourceDirectory })
}

export const CLI_PACKAGE = packageContract('apps/cli', 'dist/npm/notifai')
export const PROTOCOL_PACKAGE = packageContract('packages/protocol')
export const PUBLISHABLE_PACKAGES = Object.freeze([PROTOCOL_PACKAGE, CLI_PACKAGE])
