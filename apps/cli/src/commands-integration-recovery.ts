import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { EXIT, type CommandDeps } from './commands-core.js'
import { managedInstallation } from './native-installation.js'
import type { Installation, IntegrationOperation } from './installation.js'
import type { NativeInstallFlags } from './commands-native-installation.js'
import { canonicalPath, sameLocalPath } from './local-path.js'
import { processIdentityLiveness, type ProcessIdentity } from './process-identity.js'

const POSIX_PROCESS_START = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/

/** Explicit operator testimony about an assessed local publication route.
 * These fields do not manufacture an OS exclusion boundary. The CLI checks
 * known identities; the responsible agent establishes and maintains the pause. */
export function inspectIntegrationQuiescence(value: unknown, operation: IntegrationOperation,
  liveness: typeof processIdentityLiveness = processIdentityLiveness): void {
  const observed = value as { schema?: unknown; domain?: unknown; scope?: unknown; publication?: unknown;
    competing_publishers?: unknown; writers?: ProcessIdentity[] } | null
  if (!observed || observed.schema !== 1 || observed.domain !== 'local-classic-cli' ||
      observed.publication !== 'all-writers-observed-stopped' || observed.competing_publishers !== 'paused' ||
      typeof observed.scope !== 'string' || !path.isAbsolute(observed.scope) ||
      !sameLocalPath(canonicalPath(observed.scope), operation.scope, process.platform) ||
      !Array.isArray(observed.writers) || observed.writers.length > 64 ||
      observed.writers.some(writer => !writer || !Number.isSafeInteger(writer.pid) || writer.pid < 1 ||
        typeof writer.start !== 'string' || !POSIX_PROCESS_START.test(writer.start))) {
    throw new Error('An independently observed local host publication pause is required; unknown routing or surviving descendants remains pending')
  }
  for (const writer of observed.writers) if (liveness(writer) !== 'gone') {
    throw new Error('An observed host publication writer is still running or uncertain')
  }
}

/** The existing install lifecycle admission remains available during a
 * removing-phase uninstall. Ordinary hooks commands gain no barrier bypass. */
export function integrationRecoveryCommand(deps: CommandDeps, flags: NativeInstallFlags, supplied?: Installation): number {
  const emit = (value: Record<string, unknown>, message: string) => deps.io.out(flags.json || !deps.io.interactive
    ? JSON.stringify(value, null, 2) : message)
  try {
    if ((deps.hookPlatform ?? process.platform) === 'win32' || !flags.recoverIntegration ||
        flags.migrateNpm || flags.prepare || flags.resume || flags.scope || flags.node || flags.artifact || flags.upgrade ||
        flags.directory || flags.inventory || flags.channel || flags.version || flags.shell ||
        flags.source !== undefined && flags.source !== 'manual' ||
        flags.confirm !== undefined && !flags.quiescence || flags.quiescence !== undefined && !flags.confirm) {
      throw new Error('Use install --recover-integration <token> to inspect, then --quiescence <observation.json> --confirm <digest> to release the reservation')
    }
    const installation = supplied ?? managedInstallation(deps), before = installation.inspect()
    const operation = installation.pendingIntegrationOperations().find(item => item.token === flags.recoverIntegration)
    if (!operation || !before.active) throw new Error('The named host publication reservation is unavailable')
    const confirmation = installation.integrationRecoveryConfirmation(operation.token)
    if (flags.quiescence === undefined) {
      emit({ ok: true, read_only: true, code: 'integration_recovery_assessed', operation, confirmation,
        next_step: 'The responsible agent must establish a local Hermes publication pause, observe the original coordinator and all installer/wrapper/Python/git writers stopped, and preserve that pause through release. Unknown routing or unidentified descendants stays pending. Approval binds this exact reservation; matching files or a dead caller alone is insufficient.' },
      'Inspect the exact host publication route and arrange its scoped pause before releasing this reservation.')
      return EXIT.ok
    }
    const file = path.resolve(flags.quiescence), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error('Quiescence observation must be a bounded regular file')
    const observation: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const released = installation.releaseIntegrationOperation(operation.token, flags.confirm!, before.active.generation,
      current => inspectIntegrationQuiescence(observation, current))
    emit({ ok: true, code: 'integration_reservation_released', operation: released,
      quiescence: 'operator-confirmed', original_operation_completed: false, files_changed: false,
      next_step: before.uninstall_pending ? 'Resume the existing native uninstall. Its removing barrier remains in place.'
        : 'Reassess the current plugin and User intent with the normal owned integration commands. No original install, enable or remove action was replayed.' },
    'Reservation released after operator-confirmed host quiescence. Plugin files and enablement are preserved; the plugin outcome requires reassessment.')
    return EXIT.ok
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ ok: false, code: 'integration_recovery_pending', message }, message)
    return EXIT.failed
  }
}
