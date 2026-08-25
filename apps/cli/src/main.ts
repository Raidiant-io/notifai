#!/usr/bin/env node
import { realIo, type CommandDeps } from './commands.js'
import { defaultCredentialStore } from './credentials.js'
import { nativeSkills } from './native-skills.js'
import { argvFlagNames, bootstrapLogger } from './logging.js'
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

const startedAt = Date.now()
process.on('exit', (code) => {
  logger.info('cli.end', {
    exit: code,
    duration_ms: Date.now() - startedAt,
    flags: argvFlagNames(process.argv.slice(2)),
  })
})

await buildProgram(deps).parseAsync(process.argv)
