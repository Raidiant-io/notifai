import path from 'node:path'
import { buildIdentity, Distribution, RELEASE_TARGETS, type ReleaseTarget } from './distribution.js'
import { resolveHookAdapterHome } from './hook-adapter.js'
import { Installation } from './installation.js'
import { RELEASE_PUBLIC_KEYS } from './release-trust.js'

export function managedInstallation(deps: { env: NodeJS.ProcessEnv; hookAdapterHome?: string; hookPlatform?: NodeJS.Platform; fetchImpl?: typeof fetch | undefined }): Installation {
  const build = buildIdentity()
  if (!build || build.sourceDirty || !RELEASE_TARGETS.includes(build.target as ReleaseTarget)) {
    throw new Error('Use a clean standalone Notifai build to manage the native installation')
  }
  if (Object.keys(RELEASE_PUBLIC_KEYS).length === 0) throw new Error('This candidate has no configured release trust root; native installation is not published yet')
  const home = resolveHookAdapterHome(deps.hookAdapterHome, deps.env, deps.hookPlatform)
  return new Installation({ root: path.join(home, '.notifai'), target: build.target as ReleaseTarget,
    distribution: new Distribution(RELEASE_PUBLIC_KEYS, deps.fetchImpl) })
}
