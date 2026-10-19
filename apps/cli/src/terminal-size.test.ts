import { describe, expect, it } from 'vitest'
import { FALLBACK_TERMINAL_SIZE, ensureUsableTerminalSize } from './terminal-size.js'

describe('ensureUsableTerminalSize', () => {
  it('gives an unsized pty a usable size', () => {
    const stream = { isTTY: true, columns: 0, rows: 0 }
    ensureUsableTerminalSize(stream)
    expect({ columns: stream.columns, rows: stream.rows }).toEqual(FALLBACK_TERMINAL_SIZE)
  })

  it('keeps a real size and follows real resizes', () => {
    const stream = { isTTY: true, columns: 132, rows: 40 }
    ensureUsableTerminalSize(stream)
    expect([stream.columns, stream.rows]).toEqual([132, 40])
    // Node writes the measured size straight onto the stream on SIGWINCH.
    stream.columns = 100
    stream.rows = 30
    expect([stream.columns, stream.rows]).toEqual([100, 30])
    stream.columns = 0
    stream.rows = 0
    expect([stream.columns, stream.rows]).toEqual([80, 24])
  })

  it('leaves a size the runtime has locked alone instead of throwing', () => {
    const stream = { isTTY: true, rows: 0 } as { isTTY: boolean; columns: number; rows: number }
    Object.defineProperty(stream, 'columns', { value: 0, configurable: false, enumerable: true })
    expect(() => ensureUsableTerminalSize(stream)).not.toThrow()
    expect([stream.columns, stream.rows]).toEqual([0, 24])
  })

  it('leaves a stream that is not a terminal without a size', () => {
    const stream: { isTTY: boolean; columns?: number } = { isTTY: false }
    ensureUsableTerminalSize(stream)
    expect(stream.columns).toBeUndefined()
  })
})
