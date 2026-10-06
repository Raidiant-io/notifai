/**
 * Everything the CLI needs to actually run a command.
 *
 * Separate from `main.ts` so that the Node floor check there can decide
 * whether this file is safe to parse at all: a static import would be hoisted
 * above the check and fail first on the very runtimes the check exists to
 * turn away.
 */
import { realIo, type CommandDeps } from './commands.js'
import { defaultCredentialStore } from './credentials.js'
import { nativeSkills } from './native-skills.js'
import { argvFlagNames, bootstrapLogger, nullLogger } from './logging.js'
import { buildProgram } from './program.js'
import { spawnQuestionSettlement } from './question-settlement-process.js'
import { buildIdentity } from './distribution.js'

/**
 * The local record for this invocation.
 *
 * Source execution starts logging here. Compiled execution first admits the
 * command to its managed installation; portable diagnostics and rejected
 * commands never read logging configuration or write local logs.
 */
// Installers verify a staged payload before activation. That check must not
// create logs or inspect the user's configuration as a side effect.
const compiled = buildIdentity() !== null
const logger = compiled || ['self-check', 'install'].includes(process.argv[2] ?? '') ? nullLogger() : bootstrapLogger()

const deps: CommandDeps = {
  io: realIo(),
  store: defaultCredentialStore(),
  env: process.env,
  cwd: process.cwd(),
  nativeSkills,
  spawnQuestionSettlement,
  logger,
}

const startedAt = Date.now()
process.on('exit', (code) => {
  deps.logger?.info('cli.end', {
    exit: code,
    duration_ms: Date.now() - startedAt,
    flags: argvFlagNames(process.argv.slice(2)),
  })
})

await buildProgram(deps, { beforeAction(admission) {
  if (compiled && (admission === 'managed' || admission === 'retained-owner')) deps.logger = bootstrapLogger()
} }).parseAsync(process.argv)
