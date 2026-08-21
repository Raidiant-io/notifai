#!/usr/bin/env node
import { realIo, type CommandDeps } from './commands.js'
import { defaultCredentialStore } from './credentials.js'
import { nativeSkills } from './native-skills.js'
import { bootstrapLogger } from './logging.js'
import { buildProgram } from './program.js'

/**
 * The local record for this invocation.
 *
 * Built before the command tree so that the very first thing recorded is the
 * command starting — including for a command that goes on to fail before it has
 * resolved anything. It configures itself from disk and disables itself if it
 * cannot write, so nothing below has to handle it failing.
 */
const logger = bootstrapLogger()

const deps: CommandDeps = {
  io: realIo(),
  store: defaultCredentialStore(),
  env: process.env,
  cwd: process.cwd(),
  nativeSkills,
  logger,
}

/**
 * Which flags were passed, without their values.
 *
 * The flag names answer nearly every question worth asking of an invocation —
 * was `--reply` set, was `--all` — while the values are notification content
 * and user text that has no business being recorded merely because a command
 * ran. Values are available under `log_level = debug`, which is a deliberate act.
 */
function flagNames(argv: readonly string[]): string[] {
  return argv.filter((token) => token.startsWith('--'))
}

const startedAt = Date.now()
process.on('exit', (code) => {
  logger.info('cli.end', {
    exit: code,
    duration_ms: Date.now() - startedAt,
    flags: flagNames(process.argv.slice(2)),
  })
})

await buildProgram(deps).parseAsync(process.argv)
