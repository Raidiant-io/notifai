/**
 * Claude Code Session Attendants from runtimes older than the shared hub
 * recognise their own attend handler only in a shell-form `command` string.
 * Rewriting the hooks to exec form while one of them runs makes it conclude
 * that its handler was removed, and it withdraws: an idle session loses
 * presence and its nudges until its next hook. So the form change waits while
 * any of them runs, and the hub applies it once the last one has gone or
 * handed its session over at its next hook.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { claimHolderMayRun, readClaimFile } from './hook-question-lock.js'
import { compareReleasePrecedence } from './version.js'

/** The first release whose Claude attendants read exec-form hooks (the hub release). */
export const EXEC_FORM_READER_VERSION = '13.1.0-beta.3'

/**
 * Live Claude Code attendants that only read shell-form hooks: a claim held by
 * a running process that is not the hub. The hub (and every build that has
 * one) reads both forms; only per-session attendants from before it hold a
 * claim of their own on macOS and Linux, and their claims name a version
 * before the hub's.
 */
export function olderClaudeAttendantsAlive(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return 0
  const directory = path.join(stateDir(env, platform), 'sessions')
  let names: string[]
  try { names = readdirSync(directory) } catch { return 0 }
  let alive = 0
  for (const name of names) {
    if (!name.endsWith('.attendant')) continue
    const claim = readClaimFile(path.join(directory, name))
    if (claim === null || claim['role'] === 'hub' || !claimHolderMayRun(claim)) continue
    const version = claim['runtime_version']
    if (typeof version === 'string' && !['before', 'unparseable'].includes(compareReleasePrecedence(version, EXEC_FORM_READER_VERSION))) continue
    let harness: unknown = 'claude-code'
    try { harness = (JSON.parse(readFileSync(path.join(directory, `${name.slice(0, -'.attendant'.length)}.json`), 'utf8')) as { harness?: unknown }).harness }
    catch { /* No readable state: count it; an unknown holder is not proof of safety. */ }
    if (harness === 'claude-code' || harness === undefined) alive += 1
  }
  return alive
}

export interface ClaudeFormDeferral { schema: 1; claude_config_dir: string | null; file: string; at: number }

export function claudeFormDeferralPath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'claude-hook-form-deferred.json')
}

/** A form change an install or update wanted but held back for older attendants. */
export function recordClaudeFormDeferral(env: NodeJS.ProcessEnv, file: string, now: number = Date.now()): void {
  try {
    const value: ClaudeFormDeferral = { schema: 1, claude_config_dir: env['CLAUDE_CONFIG_DIR'] ?? null, file, at: now }
    atomicWriteFileSync(claudeFormDeferralPath(env), `${JSON.stringify(value)}\n`)
  } catch { /* The next install or update decides again. */ }
}

export function clearClaudeFormDeferral(env: NodeJS.ProcessEnv): void {
  try { if (existsSync(claudeFormDeferralPath(env))) rmSync(claudeFormDeferralPath(env), { force: true }) } catch { /* best effort */ }
}

export function readClaudeFormDeferral(env: NodeJS.ProcessEnv): ClaudeFormDeferral | null {
  try {
    const value = JSON.parse(readFileSync(claudeFormDeferralPath(env), 'utf8')) as ClaudeFormDeferral
    return value?.schema === 1 && typeof value.file === 'string' && path.isAbsolute(value.file) &&
      (value.claude_config_dir === null || (typeof value.claude_config_dir === 'string' && path.isAbsolute(value.claude_config_dir))) ? value : null
  } catch {
    return null
  }
}
