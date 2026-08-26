import {setTimeout as delay} from 'node:timers/promises'
import {execCommand} from './cross-platform.mjs'

export const REGISTRY_LOOKUP_ATTEMPTS = 5

function errorText(error) {
  return [error?.message, error?.stdout, error?.stderr]
    .filter(value => value !== undefined)
    .map(String)
    .join('\n')
}

export function isRegistryNotFound(error) {
  return /\bE404\b|404 Not Found/i.test(errorText(error))
}

export async function lookupPublishedTarball(
  label,
  {
    lookup = requested => execCommand('npm', ['view', requested, 'dist.tarball'], {
      encoding: 'utf8',
    }).trim(),
    wait = delay,
    attempts = REGISTRY_LOOKUP_ATTEMPTS,
    onRetry = ({attempt, delayMs}) => {
      console.warn(
        `${label}: npm returned E404; retrying registry lookup in ${delayMs}ms ` +
        `(attempt ${attempt + 1} of ${attempts})`,
      )
    },
  } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await lookup(label)
    } catch (error) {
      if (!isRegistryNotFound(error) || attempt === attempts) throw error
      const delayMs = 1000 * (2 ** (attempt - 1))
      onRetry({attempt, delayMs})
      await wait(delayMs)
    }
  }
  throw new Error(`registry lookup exhausted for ${label}`)
}
