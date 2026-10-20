/** A verified, still-running local Gateway service is required before ask admission. */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { sourceIntegrationRevision } from './integration-revision.js'
import { openclawPluginPath, openclawStateDir } from './openclaw-plugin.js'
import { processIdentityLiveness } from './process-identity.js'

/**
 * The Gateway is ready only while it runs the plugin generation installed on
 * disk. A running Gateway keeps its loaded plugin until it applies a reload,
 * so after an install or update the older generation may still be serving.
 * Its readiness names the revision it loaded; answers are routed through it
 * only when that equals the installed revision.
 */
export function openclawGatewayReady(env: NodeJS.ProcessEnv): boolean {
  try {
    const file = path.join(openclawStateDir(env), 'notifai', 'continuation-ready.json')
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return false
    const value = raw as Record<string, unknown>
    if (typeof value['pid'] !== 'number' || typeof value['start'] !== 'string' ||
        typeof value['script'] !== 'string' || typeof value['script_mtime'] !== 'number' ||
        typeof value['integration_revision'] !== 'string') return false
    const installed = sourceIntegrationRevision(readFileSync(openclawPluginPath(env), 'utf8'))
    if (installed === null || installed !== value['integration_revision']) return false
    if (processIdentityLiveness({ pid: value['pid'], start: value['start'] }) !== 'alive') return false
    return statSync(value['script']).mtimeMs === value['script_mtime']
  } catch {
    return false
  }
}
