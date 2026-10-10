import { inspectExecutionDomain } from './cli-execution-domain.js'
import path from 'node:path'
import { buildIdentity, Distribution, RELEASE_TARGETS, type ReleaseTarget } from './distribution.js'
import { resolveHookAdapterHome } from './hook-adapter.js'
import { Installation } from './installation.js'
import { RELEASE_PUBLIC_KEYS } from './release-trust.js'
import { stateDir } from './config.js'
import { legacyNpmMigration } from './legacy-npm-migration.js'
import { currentRuntimeBuild } from './launch-self.js'

export type IntegrationPublication = <T>(action: () => T) => T

/** Capture authority before asynchronous assessment, then fence the synchronous
 * owned-file transaction at publication. Never acquire this lock for a host,
 * package manager, network request or User response. */
export function integrationPublication(deps: Parameters<typeof managedInstallation>[0]): IntegrationPublication {
  if (buildIdentity() === null) return action => action()
  const installation = managedInstallation(deps), active = installation.inspect().active
  const reference = currentRuntimeBuild(deps.env)
  if (!active || reference?.build !== active.active) throw new Error('Update superseded before integration assessment')
  return action => installation.publishIntegration(active.generation, action, reference)
}

export function managedInstallation(deps: { env: NodeJS.ProcessEnv; hookAdapterHome?: string; hookPlatform?: NodeJS.Platform; fetchImpl?: typeof fetch | undefined }): Installation {
  const build = buildIdentity()
  if (!build || build.sourceDirty || !RELEASE_TARGETS.includes(build.target as ReleaseTarget)) {
    throw new Error('Use a clean standalone Notifai build to manage the native installation')
  }
  if (Object.keys(RELEASE_PUBLIC_KEYS).length === 0) throw new Error('This candidate has no configured release trust root; native installation is not published yet')
  const home = resolveHookAdapterHome(deps.hookAdapterHome, deps.env, deps.hookPlatform)
  const platform = deps.hookPlatform ?? process.platform
  const stable = path.join(home, '.notifai', 'bin', platform === 'win32' ? 'notifai.exe' : 'notifai')
  const executionDomain = inspectExecutionDomain(deps.env, platform)
  return new Installation({ root: path.join(home, '.notifai'), target: build.target as ReleaseTarget,
    sessionsDirectory: path.join(stateDir(deps.env, platform), 'sessions'),
    externalWriters: () => legacyNpmMigration(deps.env, platform, stable, { nativeHome: home, executionDomain }).collisions.length
      ? 'Another command route can still start an unaudited runtime; repair that route before activation.' : null,
    distribution: new Distribution(RELEASE_PUBLIC_KEYS, deps.fetchImpl) })
}
