import { spawn } from 'node:child_process'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ProcessIdentity } from './process-identity.js'

export type NpmManager = ProcessIdentity
export interface NpmManagerResult {
  manager: NpmManager | null
  /** GO was queued; the manager may have started. This is not execution proof. */
  started: boolean
  exit_code: number | null
  stdout: string
  stderr: string
  failure?: string
}

/** Execute one already prepared npm operation. The caller owns package,
 * manager, prefix and artifact verification; this module owns only the native
 * suspended-start handshake and its finite process lifetime. Nothing resolves PATH.
 *
 * `admit` runs synchronously while npm is suspended. It must persist this exact
 * manager identity, establish old reader completion and recheck the authorized
 * operation before returning.
 * Throwing sends no GO. An exit code never authorizes deleting the operation
 * receipt: the caller must also verify the package and every affected shim.
 * This is process custody, not protection against new package readers. The
 * caller owns the explicit, observed cooperative maintenance window.
 */
export function runNpmManager(input: {
  launcher: string
  executable: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  admit: (manager: NpmManager) => undefined
  timeoutMs?: number
}): Promise<NpmManagerResult> {
  if (process.platform !== 'win32') throw new Error('Npm manager custody requires Windows')
  if (![input.launcher, input.executable, input.cwd].every(file => path.isAbsolute(file))) throw new Error('Invalid npm operation')
  const timeout = input.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error('Invalid npm operation deadline')
  return new Promise(resolve => {
    const result: NpmManagerResult = { manager: null, started: false, exit_code: null, stdout: '', stderr: '' }
    const child = spawn(input.launcher, ['--internal-npm-manager', input.executable, ...input.args], {
      cwd: input.cwd, env: input.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let header = Buffer.alloc(0), announced = false, finished = false
    let forceDeadline: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      clearTimeout(forceDeadline)
      resolve(result)
    }
    const fail = (message: string) => {
      if (finished) return
      result.failure ??= message
      child.stdin.destroy()
      // On Windows this terminates the supervisor; its job closes and kills
      // the exact manager. A deadline result remains uncertain until the caller
      // observes that recorded manager gone and performs scoped recovery.
      child.kill('SIGKILL')
      forceDeadline ??= setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref()
        finish()
      }, 5000)
    }
    const deadline = setTimeout(() => fail('Npm conversion exceeded its deadline; recover the recorded operation'), timeout)
    child.once('error', () => fail('The native npm supervisor could not be started'))
    child.stdin.on('error', () => fail('The native npm supervisor closed before admission completed'))
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(result.stderr) + chunk.length > 64 * 1024) return fail('Npm error output exceeded its limit')
      result.stderr += chunk.toString('utf8')
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (!announced) {
        header = Buffer.concat([header, chunk])
        const end = header.indexOf(10)
        if (end === -1) {
          if (header.length > 1024) fail('Invalid native npm admission report')
          return
        }
        if (end > 1024 || result.failure) return fail('Invalid native npm admission report')
        try {
          const value = JSON.parse(header.subarray(0, end).toString('utf8')) as Partial<NpmManager>
          if (!Number.isSafeInteger(value.pid) || value.pid! < 1 || typeof value.start !== 'string' ||
              !/^windows-filetime:\d+$/.test(value.start)) {
            throw new Error('Invalid native npm admission report')
          }
          result.manager = { pid: value.pid!, start: value.start }
          announced = true
          // Never await an asynchronous decision with suspended npm as a
          // background promise. Network preparation and User decisions precede
          // this bounded, synchronous publication boundary.
          const admission: unknown = input.admit(result.manager)
          if (admission !== undefined) {
            // Refuse asynchronous admission and consume its rejection so a
            // mistaken async callback cannot crash the recovering caller.
            void Promise.resolve(admission).catch(() => {})
            throw new Error('Npm admission must finish synchronously')
          }
          if (performance.now() >= expires) throw new Error('Npm admission exceeded its deadline')
          child.stdin.end('G')
          result.started = true
        } catch (error) { return fail(error instanceof Error ? error.message : 'Npm admission failed') }
        chunk = header.subarray(end + 1)
        header = Buffer.alloc(0)
      }
      if (Buffer.byteLength(result.stdout) + chunk.length > 64 * 1024) return fail('Npm output exceeded its limit')
      result.stdout += chunk.toString('utf8')
    })
    const expires = performance.now() + timeout
    child.once('close', code => {
      result.exit_code = code
      if (!result.started) result.failure ??= 'Npm did not start; the legacy package remains unconverted'
      finish()
    })
  })
}
