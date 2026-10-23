import { PassThrough } from 'node:stream'
import { describe,expect,it } from 'vitest'
import { readStdinWithTimeout } from './hook-input.js'

describe('hook input reader', () => {
  it('rejects a timeout when the harness pipe delivered no bytes', async () => {
    const input = new PassThrough()
    await expect(readStdinWithTimeout(input, 5)).rejects.toThrow(/timed out waiting 5ms/)
  })

  it('preserves complete buffered JSON when the stream fails after delivering it', async () => {
    const input = new PassThrough()
    const reading = readStdinWithTimeout(input, 1_000)
    input.write('{"session_id":"kept"}')
    input.destroy(new Error('late pipe failure'))
    await expect(reading).resolves.toBe('{"session_id":"kept"}')
  })
})
