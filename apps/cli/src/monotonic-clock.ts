/**
 * System-wide monotonic nanoseconds, comparable between processes and between
 * the Node and compiled Bun runtimes on one machine within one boot.
 *
 * Node's `process.hrtime` reads the OS clock libuv uses. Bun's starts at zero
 * in every process, so stamps written by one native process cannot be ordered
 * against another's. The native runtime reads that same OS clock directly.
 */
type Symbols = Record<string, (...args: unknown[]) => unknown>
interface BunFfi {
  dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): { symbols: Symbols }
  ptr(view: ArrayBufferView): unknown
}

let bunClock: (() => bigint) | undefined

export function systemMonotonicNs(): bigint {
  if (process.versions['bun'] === undefined) return process.hrtime.bigint()
  bunClock ??= osMonotonicClock()
  return bunClock()
}

function osMonotonicClock(): () => bigint {
  const load = (import.meta as unknown as { require?: (id: string) => unknown }).require
  const ffi = load?.('bun:ffi') as BunFfi | undefined
  if (ffi === undefined) throw new Error('The native runtime cannot read the system monotonic clock')
  if (process.platform === 'darwin') {
    // libuv on macOS reads mach_continuous_time, which this clock exposes in nanoseconds.
    const CLOCK_MONOTONIC_RAW = 4
    const { symbols } = ffi.dlopen('/usr/lib/libSystem.B.dylib', { clock_gettime_nsec_np: { args: ['u32'], returns: 'u64' } })
    return () => BigInt(symbols['clock_gettime_nsec_np']!(CLOCK_MONOTONIC_RAW) as bigint | number)
  }
  if (process.platform === 'linux') {
    const CLOCK_MONOTONIC = 1
    const { symbols } = ffi.dlopen('libc.so.6', { clock_gettime: { args: ['i32', 'ptr'], returns: 'i32' } })
    const time = new BigInt64Array(2), address = ffi.ptr(time)
    return () => {
      if (symbols['clock_gettime']!(CLOCK_MONOTONIC, address) !== 0) throw new Error('System monotonic clock read failed')
      return time[0]! * 1_000_000_000n + time[1]!
    }
  }
  if (process.platform === 'win32') {
    // libuv on Windows scales QueryPerformanceCounter by its fixed frequency.
    const { symbols } = ffi.dlopen('kernel32.dll', {
      QueryPerformanceCounter: { args: ['ptr'], returns: 'i32' },
      QueryPerformanceFrequency: { args: ['ptr'], returns: 'i32' },
    })
    const value = new BigInt64Array(1), address = ffi.ptr(value)
    if (symbols['QueryPerformanceFrequency']!(address) === 0 || value[0]! <= 0n) throw new Error('System monotonic clock is unavailable')
    const frequency = value[0]!
    return () => {
      if (symbols['QueryPerformanceCounter']!(address) === 0) throw new Error('System monotonic clock read failed')
      return value[0]! * 1_000_000_000n / frequency
    }
  }
  throw new Error('The native runtime has no system monotonic clock on this platform')
}
