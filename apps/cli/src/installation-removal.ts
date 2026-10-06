import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, rmSync, rmdirSync } from 'node:fs'
import path from 'node:path'

export interface RemovalPlan { schema: 1; files: Array<{ name: string; sha256: string }>; directories: string[] }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const safe = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && name.length < 4096 &&
  !/[\\\0:\r\n]/.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..')
const allowed = (name: string) => /^(?:active|install|shell-path|windows-path)\.json$/.test(name) ||
  /^bin\/notifai(?:\.exe)?$/.test(name) || /^channels\/(?:stable|beta)\.json$/.test(name) ||
  /^versions\/[a-f0-9]{64}\/.+$/.test(name) || /^openclaw-hosts\/[a-f0-9]{64}\.json$/.test(name) ||
  /^runtime-retention\/[a-f0-9]{64}\/(?:retired\.json|resumed\.json|owners\/[a-f0-9]{64}\.json)$/.test(name)
export const executableMember = (name: string): boolean => /^(?:bin|versions\/[a-f0-9]{64})\/notifai(?:-runtime)?(?:\.exe)?$/.test(name)
export function removalFilePresent(file: string): boolean {
  try { lstatSync(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function directoriesFor(names: readonly string[]): string[] {
  const directories = new Set<string>()
  for (const name of names) for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent)
  return [...directories].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))
}
/** A persisted local removal plan is bounded to installation records and
 * immutable version trees. It can never authorize deletion of User state. */
export function removalPlan(value: unknown): RemovalPlan {
  const plan = value as Partial<RemovalPlan> | null
  if (!plan || plan.schema !== 1 || !Array.isArray(plan.files) || plan.files.length === 0 || plan.files.length > 4096 ||
      plan.files.some(item => !item || !safe(item.name) || !allowed(item.name) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) ||
      new Set(plan.files.map(item => item.name)).size !== plan.files.length ||
      !Array.isArray(plan.directories) || JSON.stringify(plan.directories) !== JSON.stringify(directoriesFor(plan.files.map(item => item.name)))) {
    throw new Error('Uninstall removal plan needs repair')
  }
  if (Buffer.byteLength(JSON.stringify(plan)) > 192 * 1024) throw new Error('Removal plan exceeds its size limit')
  return plan as RemovalPlan
}
export function captureRemovalPlan(root: string, names: readonly string[], check: (file: string, directory: boolean) => void): RemovalPlan {
  const files = [...new Set(names)].map(name => {
    if (!safe(name) || !allowed(name)) throw new Error('Invalid removal member')
    const file = path.join(root, name)
    check(file, false)
    if (lstatSync(file).size > 512 * 1024 * 1024) throw new Error('Removal member exceeds its size limit')
    return { name, sha256: digest(readFileSync(file)) }
  })
  return removalPlan({ schema: 1, files, directories: directoriesFor(files.map(item => item.name)) })
}
export function verifyRemovalPlan(root: string, plan: RemovalPlan, check: (file: string, directory: boolean) => void): void {
  removalPlan(plan)
  check(root, true)
  for (const name of [...plan.directories].reverse()) if (removalFilePresent(path.join(root, name))) check(path.join(root, name), true)
  for (const item of plan.files) {
    const file = path.join(root, item.name)
    if (!removalFilePresent(file)) continue // A previous attempt may have removed it.
    check(file, false)
    if (lstatSync(file).size > 512 * 1024 * 1024 || digest(readFileSync(file)) !== item.sha256) throw new Error(`Uninstall member changed: ${file}`)
  }
}
/** Caller has verified the complete plan and native process absence. Delete
 * only exact recorded bytes, metadata last; never recursively remove a tree. */
export function removePlannedFiles(root: string, plan: RemovalPlan, check: (file: string, directory: boolean) => void,
  observe?: () => void): void {
  verifyRemovalPlan(root, plan, check)
  const priority = (name: string) => name === 'install.json' ? 4 : name === 'active.json' ? 3 : executableMember(name) ? 2 : 1
  for (const item of [...plan.files].sort((a, b) => priority(a.name) - priority(b.name))) {
    const file = path.join(root, item.name)
    if (!removalFilePresent(file)) continue
    check(file, false)
    if (digest(readFileSync(file)) !== item.sha256) throw new Error(`Uninstall member changed: ${file}`)
    rmSync(file)
    observe?.()
  }
  for (const directory of plan.directories) {
    const file = path.join(root, directory)
    if (!removalFilePresent(file)) continue
    check(file, true)
    try { rmdirSync(file) } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      // Unrelated contents are preserved, including other commands in bin/.
    }
  }
}
