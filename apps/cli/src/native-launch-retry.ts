import { spawn } from 'node:child_process'
import os from 'node:os'

/** Only admission can issue this, before an action or stdin read. It is never
 * a retry policy for commands which may already have produced effects. */
export class NativeSelectionChanged extends Error {
  constructor(readonly executable: string, readonly attempts: number) {
    super('The active installation changed while this command was starting')
  }
}

/** Preserve the original descriptors, argument vector and hook ancestry. The
 * C launcher revalidates the active target and distinguishes this stable route
 * from an explicitly selected obsolete immutable executable. */
export async function retryNativeSelection(change: NativeSelectionChanged, args: readonly string[],
  context: { cwd: string; env: NodeJS.ProcessEnv; invokingNpmAdapterArtifact?: string | undefined }): Promise<number> {
  const env = { ...context.env, NOTIFAI_NATIVE_RETRY: String(change.attempts + 1),
    ...(context.invokingNpmAdapterArtifact ? { NOTIFAI_NPM_ADAPTER_ARTIFACT: context.invokingNpmAdapterArtifact } : {}) }
  const child = spawn(change.executable, [...args], { cwd: context.cwd, env, stdio: 'inherit', windowsHide: true })
  const signals = ['SIGINT', 'SIGTERM'] as const
  const handlers = signals.map(signal => { const handler = () => child.kill(signal); process.on(signal, handler); return handler })
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    if (result.signal !== null) {
      signals.forEach((signal, i) => process.removeListener(signal, handlers[i]!))
      // POSIX callers retain signal termination, rather than receiving a
      // successful parent status after the forwarded command was interrupted.
      if (process.platform !== 'win32') process.kill(process.pid, result.signal)
      return 128 + (os.constants.signals[result.signal] ?? 0)
    }
    return result.code ?? 1
  } finally { signals.forEach((signal, i) => process.removeListener(signal, handlers[i]!)) }
}
