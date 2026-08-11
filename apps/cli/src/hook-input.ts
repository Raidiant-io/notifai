import type { Readable } from 'node:stream'

const TRUNCATED_INPUT_SUFFIX = '\n[notifai: hook input truncated]\n'

/**
 * Read one harness-hook envelope without letting a stuck pipe hold the prompt.
 *
 * A timeout or stream error before any bytes arrive rejects, so the hook can
 * record that its input was unavailable. Once bytes exist they are more useful
 * than the transport failure: complete JSON can still run, while partial or
 * capped JSON reaches the hook's malformed/truncated diagnostic.
 */
export function readStdinWithTimeout(
  input: Readable = process.stdin,
  timeoutMs = 2_000,
  maxBytes = 1_000_000,
): Promise<string> {
  if ((input as Readable & { isTTY?: boolean }).isTTY === true) return Promise.resolve('')

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timer)
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('error', onError)
      input.destroy()
    }
    const finishBuffered = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const failEmpty = (err: Error): void => {
      if (settled) return
      if (chunks.length > 0) return finishBuffered()
      settled = true
      cleanup()
      reject(err)
    }
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = Math.max(0, maxBytes - total)
      if (bytes.length <= remaining) {
        chunks.push(bytes)
        total += bytes.length
        return
      }
      if (remaining > 0) {
        chunks.push(bytes.subarray(0, remaining))
        total += remaining
      }
      chunks.push(Buffer.from(TRUNCATED_INPUT_SUFFIX))
      finishBuffered()
    }
    const onEnd = (): void => finishBuffered()
    const onError = (err: Error): void => failEmpty(err)

    const timer = setTimeout(
      () => failEmpty(new Error(`timed out waiting ${timeoutMs}ms for hook input`)),
      timeoutMs,
    )
    timer.unref?.()
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('error', onError)
  })
}
