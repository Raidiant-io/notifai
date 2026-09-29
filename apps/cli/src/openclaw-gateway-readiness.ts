/** A verified, still-running local Gateway service is required before ask admission. */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { openclawStateDir } from './openclaw-plugin.js'
import { processIdentityLiveness } from './process-identity.js'

export function openclawGatewayReady(env: NodeJS.ProcessEnv): boolean {
  try {
    const file = path.join(openclawStateDir(env), 'notifai', 'continuation-ready.json')
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return false
    const value = raw as Record<string, unknown>
    if (typeof value['pid'] !== 'number' || typeof value['start'] !== 'string' ||
        typeof value['script'] !== 'string' || typeof value['script_mtime'] !== 'number') return false
    if (processIdentityLiveness({ pid: value['pid'], start: value['start'] }) !== 'alive') return false
    return statSync(value['script']).mtimeMs === value['script_mtime']
  } catch {
    return false
  }
}
