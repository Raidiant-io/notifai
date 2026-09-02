/**
 * The Node version this CLI needs, asserted before anything else loads.
 *
 * `engines` in package.json is advisory: npm prints a warning at install time
 * and runs the binary anyway. So a reader on an older Node met a parser or
 * module error naming a file they did not write, with no mention of Notifai,
 * of Node, or of anything to do about it.
 *
 * This module is deliberately plain — no imports, no syntax newer than the
 * floor it is checking — so it can run and report on the runtimes it exists to
 * turn away. Everything else is loaded after it passes.
 */

import { compareVersions, parseVersion } from './version.js'

export const NODE_MAJOR_FLOOR = 20
export const NODE_MINOR_FLOOR = 12

/** The major from a `process.version` string, or null when unrecognisable. */
export function nodeMajor(version: string): number | null {
  return parseVersion(version)?.[0] ?? null
}

export function belowNodeFloor(version: string): boolean {
  // An unrecognisable version is not evidence of an old runtime, and refusing
  // to run on one would strand a reader whose Node is fine.
  return compareVersions(
    version,
    `${NODE_MAJOR_FLOOR}.${NODE_MINOR_FLOOR}.0`,
  ) === 'before'
}

/** One sentence for what is wrong, one for what to do about it. */
export function nodeFloorMessage(version: string): string[] {
  return [
    `Notifai needs Node ${NODE_MAJOR_FLOOR}.${NODE_MINOR_FLOOR} or newer; this is Node ${version}.`,
    `next: install Node ${NODE_MAJOR_FLOOR}.${NODE_MINOR_FLOOR}+ (https://nodejs.org), then run this again.`,
  ]
}
