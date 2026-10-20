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
import { spawnHookMaintenance, spawnHubHandover, spawnRetirement } from './hook-maintenance.js'
import { buildIdentity } from './distribution.js'
import { consumeNpmAdapterLocator } from './cli-bin.js'
import { OWNER_STEP_BUDGETS, hookInvocation, hookStepBudgets } from './hook-budgets.js'
import { ensureUsableTerminalSize } from './terminal-size.js'

ensureUsableTerminalSize(process.stdout)
ensureUsableTerminalSize(process.stderr)

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
// A hook's nested steps live inside the timeout its harness enforces. The
// store is chosen lazily, so a hook that never reads the credential pays for
// no store probe at all.
const hook = hookInvocation(process.argv.slice(2))
const budgets = hook === null ? null : hookStepBudgets(hook.event, hook.harness)

const deps: CommandDeps = {
  io: realIo(),
  store: defaultCredentialStore(process.env, budgets === null ? {} : { helperTimeoutMs: budgets.credentialHelperMs }),
  env: process.env,
  cwd: process.cwd(),
  nativeSkills,
  spawnQuestionSettlement,
  spawnHookMaintenance,
  spawnRetirement,
  spawnHubHandover,
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
  const logging = budgets === null || budgets.logLockWaitMs === OWNER_STEP_BUDGETS.logLockWaitMs
    ? {} : { lockWaitMs: budgets.logLockWaitMs }
  if (compiled && (admission === 'managed' || admission === 'retained-owner')) deps.logger = bootstrapLogger(logging)
  else if (!compiled && !diagnostic && process.argv[2] !== 'install') deps.logger = bootstrapLogger(logging)
} }).parseAsync(process.argv)
