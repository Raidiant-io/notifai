import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { accountHome } from './platform.js'
import { buildIdentity } from './distribution.js'
import { installationAccess } from './installation-access.js'
import { inspectNpmReplacement, npmReplacementConfirmation } from './npm-replacement.js'

/** Bounded local diagnosis of the same receipts used by explicit repair.
 * Reading status neither runs npm nor asserts a maintained quiet window. */
export function pendingNpmRepairs(env: NodeJS.ProcessEnv): Array<Record<string, unknown>> {
  if (process.platform !== 'win32' || !buildIdentity()) return []
  const installationRoot = path.join(accountHome(env), '.notifai'), parent = path.join(installationRoot, 'npm-maintenance')
  try {
    const stat = lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe npm repair directory')
    const access = installationAccess()
    access.check(parent, true)
    const entries = readdirSync(parent)
    if (entries.length > 64) throw new Error('Too many npm repair records')
    return entries.map(name => {
      if (!/^[a-f0-9]{64}$/.test(name)) return null
      const operation = path.join(parent, name)
      try {
        const receipt = inspectNpmReplacement(operation, { installationRoot, access })
        if (receipt.phase === 'complete') return null
        return { operation, status: receipt.phase, version: receipt.target.version,
          confirmation: npmReplacementConfirmation(receipt),
          next_step: 'The responsible agent must re-establish the displayed scoped pause and resume this exact operation with install --migrate-npm --resume. Diagnosis does not authorize execution.' }
      } catch { return { operation, status: 'uncertain', next_step: 'Inspect this incomplete repair before modifying its package or preparation; do not discard its backup.' } }
    }).filter((value): value is NonNullable<typeof value> => value !== null)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : [{ status: 'uncertain', next_step: 'Inspect the npm repair directory before changing a legacy installation.' }]
  }
}
