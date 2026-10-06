import path from 'node:path'
import { fileURLToPath } from 'node:url'
export { Distribution, RELEASE_TARGETS } from './release-distribution.js'
export type { ReleaseArtifact, ReleaseInventory, ReleaseTarget, ReleaseChannel, ResolvedRelease, SeenChannel } from './release-distribution.js'

export interface BuildIdentity {
  version: string
  sourceRevision: string
  sourceDirty: boolean
  sourceDigest: string
  target: string
  runtime: string
}

// Replaced with a literal by the standalone compiler. Source execution has no
// native build identity; neither environment nor the working directory supplies it.
declare const NOTIFAI_COMPILED_BUILD: BuildIdentity | undefined

export function buildIdentity(): Readonly<BuildIdentity> | null {
  return typeof NOTIFAI_COMPILED_BUILD === 'undefined' ? null : NOTIFAI_COMPILED_BUILD
}

export function bundledSkillRoot(): string | null {
  return buildIdentity() === null ? null
    : path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill-source')
}
