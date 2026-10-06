import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalPath } from './local-path.js'
import type { InstallationAccess } from './installation-access.js'

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function present(file: string): boolean {
  try { lstatSync(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

/** Strict work inventory of roots registered by the native OpenClaw adapter.
 * This never reconciles or redacts a journal, and proves neither host absence
 * nor quiescence. Removal must separately drain hosts and repeat this inventory. */
export function openclawHostWork(root: string, installationId: string, access: InstallationAccess): boolean {
  const check = (file: string, directory: boolean) => {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
        (!directory && stat.size > 1024 * 1024) || (typeof process.getuid === 'function' &&
          (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) throw new Error('Uncertain OpenClaw state ownership')
    access.check(file, directory)
  }
  const read = (file: string): Record<string, unknown> => {
    check(file, false)
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Uncertain OpenClaw state')
    return value as Record<string, unknown>
  }
  const index = path.join(root, 'openclaw-hosts')
  if (!present(index)) return false
  check(root, true); check(index, true)
  let pending = false
  for (const name of readdirSync(index)) {
    const registration = read(path.join(index, name)), host = registration['root']
    if (registration['schema'] !== 1 || registration['installation_id'] !== installationId ||
        typeof host !== 'string' || !path.isAbsolute(host) || canonicalPath(host) !== host ||
        name !== digest(host) + '.json') throw new Error('Uncertain OpenClaw host registration')
    check(host, true)
    for (const kind of ['continuation-journal', 'message-journal']) {
      const directory = path.join(host, kind), message = kind === 'message-journal'
      if (!present(directory)) continue
      check(directory, true)
      for (const filename of readdirSync(directory)) {
        const file = path.join(directory, filename)
        if (message && /^[a-f0-9]{32}\.context-used$/.test(filename)) {
          check(file, false)
          if (readFileSync(file, 'utf8') !== 'used\n' || !present(path.join(directory, filename.replace(/\.context-used$/, '.json')))) {
            throw new Error('Uncertain OpenClaw context fence')
          }
          continue
        }
        if (!/^[a-f0-9]{32}\.json$/.test(filename)) throw new Error('Unfinished OpenClaw journal publication')
        const record = read(file), id = filename.slice(0, -5), generation = record['generation']
        if (record['delivery_id'] !== id || !uuid(generation) ||
            !['session_key', 'cwd', 'openclaw_session_id'].every(key => typeof record[key] === 'string') ||
            !Number.isSafeInteger(record['attempt']) || (record['attempt'] as number) < 1) throw new Error('Uncertain OpenClaw journal identity')
        if (message) {
          const messageId = record['message_id'], phase = record['phase'], text = record['text']
          if (typeof messageId !== 'string' || !/^sm_[A-Za-z0-9_-]+$/.test(messageId) ||
              digest(generation + '\0' + messageId).slice(0, 32) !== id || !uuid(record['boot_id']) ||
              typeof record['native_revision'] !== 'string' || !record['native_revision'] ||
              typeof record['deadline_ns'] !== 'string' || !/^[0-9]{1,32}$/.test(record['deadline_ns']) ||
              (text !== undefined && (typeof text !== 'string' || text.length > 32768)) ||
              !['prepared', 'submitting', 'admitted', 'transcript', 'unconfirmed'].includes(phase as string)) {
            throw new Error('Uncertain OpenClaw message journal')
          }
          if (!['transcript', 'unconfirmed'].includes(phase as string) || text !== undefined) pending = true
        } else {
          const ids = record['request_ids'], phase = record['phase']
          if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !/^req_[A-Za-z0-9_-]+$/.test(id)) ||
              digest(generation + '\0' + ids.join('\0')).slice(0, 32) !== id ||
              !['prepared', 'committed', 'submitting', 'admitted', 'transcript'].includes(phase as string)) {
            throw new Error('Uncertain OpenClaw continuation journal')
          }
          if (phase !== 'transcript') pending = true
        }
      }
    }
  }
  return pending
}
