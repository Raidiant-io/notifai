#!/usr/bin/env node
/**
 * Leave `dist/main.js` executable after `tsc` recreates it.
 *
 * TypeScript writes 0644. The CLI's shebang only works when the generated
 * file keeps the execute bit, which is how a documented `npm link` and a
 * packed POSIX install both invoke `notifai`. Windows has no execute bit
 * that matters here, so the repair is a no-op there.
 *
 * Usage: run from `apps/cli` after `tsc`.
 */
import { chmodSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const CLI_BIN = 'dist/main.js'
export const POSIX_MODE = 0o755

export function chmodCliBin(cwd = process.cwd(), platform = process.platform) {
  if (platform === 'win32') return { skipped: true, path: null, mode: null }
  const file = path.resolve(cwd, CLI_BIN)
  if (!existsSync(file)) {
    throw new Error(`${CLI_BIN} is missing; run the CLI build first`)
  }
  chmodSync(file, POSIX_MODE)
  return { skipped: false, path: file, mode: statSync(file).mode & 0o777 }
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    chmodCliBin()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
