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
import { consumeNpmAdapterLocator } from './cli-bin.js'

/**
 * The local record for this invocation.
 *
 * Logging starts only after a command action is admitted. Help, version,
 * diagnostics and rejected commands do not create local log state.
 */
// Installers verify a staged payload before activation. That check must not
// create logs or inspect the user's configuration as a side effect.
const compiled = buildIdentity() !== null
const invokingNpmAdapterArtifact = consumeNpmAdapterLocator(process.env)
const diagnostic = ['doctor', 'self-check', '--help', '-h', '--version', '-V', 'help'].includes(process.argv[2] ?? '')
const logger = nullLogger()

const deps: CommandDeps = {
  io: realIo(),
  store: defaultCredentialStore(),
  env: process.env,
  cwd: process.cwd(),
  nativeSkills,
  spawnQuestionSettlement,
  logger,
  ...(invokingNpmAdapterArtifact ? { invokingNpmAdapterArtifact } : {}),
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
  else if (!compiled && !diagnostic && process.argv[2] !== 'install') deps.logger = bootstrapLogger()
} }).parseAsync(process.argv)
